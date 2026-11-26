/**
 * Attribute answer editing for the Configuration draft: adding, removing, renaming, merging,
 * moving and reordering answers, and the Abbreviations the core suggests for them. The draft
 * state owns the Attributes themselves; this object edits them through its host and refuses
 * every edit while a save is in flight.
 */
import { SvelteMap, type SvelteSet } from 'svelte/reactivity';
import { m } from '#lib/paraglide/messages.js';
import { suggestAbbreviations } from '#lib/client/configuration-api.ts';
import { newId } from '#lib/shared/text/new-id.ts';
import {
	abbreviationTooLong,
	editAbbreviation,
	renameAnswerValue,
	shownAbbreviation
} from './abbreviation-draft.ts';
import {
	moveAnswerAmongSiblings,
	moveAnswerBesideSibling,
	moveAnswerBranchToAttribute,
	moveRefusal,
	promoteAnswerBranch,
	promoteRefusal,
	restoreAnswerOrder,
	siblingPosition,
	type MoveSource,
	type MoveTarget
} from './attribute-moves.ts';
import type { AttributeAnswerDraft, AttributeDraft } from './attribute-draft.ts';
import {
	findDuplicateSiblingOption,
	hasChildAnswers,
	hasDuplicateOptionValue,
	isAnswerInSubtree
} from './attribute-validation.ts';
import {
	mergeValue,
	removeValue,
	visibleValues,
	type ConfigurationDraft,
	type ValueTextCheck
} from './configuration-draft.ts';
import { previewRequestKey, suggestionRequest } from './preview-request.ts';

/** What the answer editing reads from, and writes back to, the draft that owns it. */
export type AnswerEditingHost = {
	attributes(): AttributeDraft[];
	setAttributes(next: AttributeDraft[]): void;
	saving(): boolean;
	draftInput(): ConfigurationDraft;
	/** The draft's unfolded Attributes and answers; adding or moving unfolds the path. */
	expandedIds: SvelteSet<string>;
};

export class AnswerEditing {
	/**
	 * The core's suggested Abbreviation for each value that has no edited one, by answer id.
	 * The frontend never generates a form: it shows what the preview answered.
	 */
	readonly suggestedAbbreviations = new SvelteMap<string, string>();
	private suggestionToken = 0;

	constructor(private readonly host: AnswerEditingHost) {}

	addAttributeOption(
		attribute: AttributeDraft,
		requestedParentId = '',
		requestedValue?: string
	): string | null {
		// The foot composer edits the Attribute's own field; a row's inline composer supplies
		// its text directly, so the two never share or clear each other's draft text.
		const fromField = requestedValue === undefined;
		const value = (requestedValue ?? attribute.newOption).trim();
		if (!value) {
			attribute.newOptionError = m.configuration_enter_option();
			return null;
		}
		const parentId = requestedParentId || undefined;
		if (hasDuplicateOptionValue(attribute, value, undefined, parentId)) {
			attribute.newOptionError = m.configuration_option_exists();
			return null;
		}

		const id = newId();
		attribute.answers.push({
			id,
			value,
			...(parentId ? { parentId } : {})
		});
		// Unfold the path down to the new answer so it shows where it was added.
		for (
			let ancestorId = parentId;
			ancestorId;
			ancestorId = attribute.answers.find((answer) => answer.id === ancestorId)?.parentId
		) {
			this.host.expandedIds.add(ancestorId);
		}
		if (fromField) attribute.newOption = '';
		attribute.newOptionError = '';
		attribute.removalError = '';
		attribute.moveError = '';
		return id;
	}

	removeAttributeOption(attributeId: string, optionId: string, removeBranch = false) {
		if (this.host.saving()) return;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		// A parent removal is allowed only after the editor's explicit disposition choice.
		if (hasChildAnswers(attribute, optionId) && !removeBranch) {
			attribute.removalError = m.configuration_answer_has_children();
			return;
		}
		attribute.removalError = '';
		attribute.moveError = '';
		attribute.answers = removeBranch
			? attribute.answers.filter(
					(answer) => !isAnswerInSubtree(attribute.answers, answer.id, optionId)
				)
			: removeValue(attribute.answers, optionId);
	}

	/**
	 * Checks an inline edit of an Attribute answer against its siblings only; a label
	 * another branch already uses is a different path. Applies the rename only when it is
	 * new and not blank.
	 */
	renameAttributeAnswer(attributeId: string, answerId: string, text: string): ValueTextCheck {
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (!attribute) return { status: 'blank' };
		if (!text.trim()) return { status: 'blank' };
		const answer = attribute.answers.find((candidate) => candidate.id === answerId);
		const sibling = findDuplicateSiblingOption(attribute, answerId, text, answer?.parentId);
		if (sibling) return { status: 'duplicate', survivorId: sibling.id };

		if (!this.host.saving()) {
			const label = text.trim();
			attribute.answers = attribute.answers.map((candidate) =>
				candidate.id === answerId ? renameAnswerValue(candidate, label) : candidate
			);
			// A generated form follows the new name; the old suggestion no longer describes it.
			this.suggestedAbbreviations.delete(answerId);
			attribute.removalError = '';
			attribute.moveError = '';
		}
		return { status: 'ok' };
	}

	/** Typing a Abbreviation edits it; clearing it returns the value to a generated form. */
	editAbbreviation(attributeId: string, answerId: string, text: string) {
		if (this.host.saving()) return;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		attribute.answers = attribute.answers.map((candidate) =>
			candidate.id === answerId ? editAbbreviation(candidate, text) : candidate
		);
		// A cleared form is generated again: the suggestion held for the old name is stale.
		if (!text.trim()) this.suggestedAbbreviations.delete(answerId);
	}

	/** The text a value's Abbreviation field shows. */
	abbreviationShown(answer: AttributeAnswerDraft): string {
		return shownAbbreviation(answer, this.suggestedAbbreviations);
	}

	/**
	 * Asks the core for the Abbreviation of every value of the draft. A draft the core would
	 * refuse (an over-long form, a blank name) keeps the suggestions it has; the Save bar
	 * explains why it cannot save.
	 */
	async loadSuggestions(expectedKey?: string) {
		const request = suggestionRequest(this.host.draftInput());
		const key = previewRequestKey(request);
		if (expectedKey !== undefined && key !== expectedKey) return;
		if (this.host.attributes().some((attribute) => attribute.answers.some(abbreviationTooLong)))
			return;
		const token = ++this.suggestionToken;
		try {
			const forms = await suggestAbbreviations(request);
			if (token !== this.suggestionToken) return;
			this.suggestedAbbreviations.clear();
			for (const form of forms) {
				if (form.abbreviationOrigin === 'generated') {
					this.suggestedAbbreviations.set(form.answerId, form.abbreviation);
				}
			}
		} catch {
			// The previous suggestions stay; a Save still lets the core generate every form.
		}
	}

	/** Folds an edited Attribute answer into a sibling; applied on Save, undone by Discard. */
	mergeAttributeAnswer(attributeId: string, foldedId: string, survivorId: string) {
		if (this.host.saving()) return;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		attribute.removalError = '';
		attribute.moveError = '';
		const survivor = attribute.answers.find((answer) => answer.id === survivorId);
		attribute.answers = mergeValue(attribute.answers, foldedId, survivorId).map((answer) =>
			answer.id === foldedId
				? {
						...answer,
						...(survivor?.parentId ? { parentId: survivor.parentId } : { parentId: undefined })
					}
				: answer
		);
	}

	/**
	 * Reparents one answer in the draft; descendants follow through their own parent
	 * references. A destination below the moved answer is refused without changing the
	 * draft. A destination whose sibling already uses the label keeps the move in the
	 * draft so it can be renamed in place, while Save all waits for the explicit valid
	 * resolution and the core refuses a colliding proposal with a coded diagnosis.
	 */
	moveAttributeAnswer(attributeId: string, answerId: string, parentId: string) {
		if (this.host.saving()) return;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		const answers = visibleValues(attribute.answers);
		const answer = answers.find((candidate) => candidate.id === answerId);
		if (!answer) return;

		const target = parentId || undefined;
		if (target && !answers.some((candidate) => candidate.id === target)) {
			attribute.moveError = m.configuration_move_parent_missing();
			return;
		}
		if (target && isAnswerInSubtree(answers, target, answerId)) {
			attribute.moveError = m.configuration_move_below_descendant();
			return;
		}

		attribute.answers = attribute.answers.map((candidate) =>
			candidate.id === answerId ? { ...candidate, parentId: target } : candidate
		);
		attribute.moveError = findDuplicateSiblingOption(attribute, answerId, answer.value, target)
			? m.configuration_move_name_conflict()
			: '';
		attribute.removalError = '';
	}

	/** Moves a value one place among its siblings; its new place, or null at an end or while saving. */
	moveAnswerSibling(
		attributeId: string,
		answerId: string,
		direction: -1 | 1
	): { position: number; count: number } | null {
		if (this.host.saving()) return null;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		const next = attribute && moveAnswerAmongSiblings(attribute.answers, answerId, direction);
		if (!attribute || !next) return null;
		attribute.answers = next;
		return siblingPosition(next, answerId);
	}

	/** Puts a value before or after a sibling; false when they are not siblings or nothing changes. */
	moveAnswerBeside(
		attributeId: string,
		answerId: string,
		targetId: string,
		after: boolean
	): boolean {
		if (this.host.saving()) return false;
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		const next = attribute && moveAnswerBesideSibling(attribute.answers, answerId, targetId, after);
		if (!attribute || !next) return false;
		attribute.answers = next;
		return true;
	}

	/** A value's place among its visible siblings. */
	answerSiblingPlace(attributeId: string, answerId: string): { position: number; count: number } {
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		return siblingPosition(attribute?.answers ?? [], answerId);
	}

	answerOrder(attributeId: string): string[] {
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		return attribute?.answers.map((answer) => answer.id) ?? [];
	}

	restoreAnswerOrder(attributeId: string, order: string[]) {
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (attribute) attribute.answers = restoreAnswerOrder(attribute.answers, order);
	}

	/**
	 * Moves an answer branch into another Attribute under a visible parent (or the top level).
	 * A refused move keeps the draft and names the reason on the source Attribute.
	 */
	moveAnswerToAttribute(source: MoveSource, target: MoveTarget): boolean {
		if (this.host.saving()) return false;
		const refusal = moveRefusal(this.host.attributes(), source, target);
		if (refusal) {
			this.setMoveError(source.attributeId, refusal);
			return false;
		}
		const next = moveAnswerBranchToAttribute(this.host.attributes(), source, target);
		if (!next) return false;

		this.host.setAttributes(next);
		this.expandPath(target.attributeId, target.parentId);
		return true;
	}

	/**
	 * Turns an answer branch into a new Attribute placed after its source. A refused promotion
	 * keeps the draft and names the reason on the source Attribute.
	 */
	promoteAnswerToAttribute(source: MoveSource): boolean {
		if (this.host.saving()) return false;
		const refusal = promoteRefusal(this.host.attributes(), source);
		if (refusal) {
			this.setMoveError(source.attributeId, refusal);
			return false;
		}
		const next = promoteAnswerBranch(this.host.attributes(), source);
		if (!next) return false;

		// The new Attribute takes the promoted answer's id, so its expansion is that id.
		this.host.setAttributes(next);
		this.host.expandedIds.add(source.answerId);
		return true;
	}

	private setMoveError(attributeId: string, reason: string) {
		const attribute = this.host.attributes().find((candidate) => candidate.id === attributeId);
		if (attribute) attribute.moveError = reason;
	}

	/** Unfolds an Attribute and the path from its root down to one answer, so a move shows where it landed. */
	private expandPath(attributeId: string, answerId = '') {
		this.host.expandedIds.add(attributeId);
		const answers =
			this.host.attributes().find((candidate) => candidate.id === attributeId)?.answers ?? [];
		for (
			let ancestorId = answerId;
			ancestorId;
			ancestorId = answers.find((answer) => answer.id === ancestorId)?.parentId ?? ''
		) {
			this.host.expandedIds.add(ancestorId);
		}
	}
}
