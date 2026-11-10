<script lang="ts">
	import { tick } from 'svelte';
	import ChoiceSelect from '#lib/shared/choice-select.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { answerPathLabel } from '#lib/shared/answer-path.ts';
	import type { AttributeAnswerDraft } from './attribute-draft.ts';
	import { isAnswerInSubtree } from './attribute-validation.ts';

	/**
	 * What to do with a parent answer's children when the parent is removed: move them
	 * somewhere else first, or remove the whole branch. It sits directly under the row
	 * whose removal is pending.
	 */
	type Props = {
		attributeId: string;
		parent: AttributeAnswerDraft;
		/** The Attribute's visible answers. */
		answers: readonly AttributeAnswerDraft[];
		onMoveAnswer: (optionId: string, parentId: string) => void;
		onRemoveOption: (optionId: string, removeBranch?: boolean) => void;
		onClose: () => void;
	};

	let { attributeId, parent, answers, onMoveAnswer, onRemoveOption, onClose }: Props = $props();

	let childRelocationDestination = $state('');

	const pendingChildren = $derived(answers.filter((answer) => answer.parentId === parent.id));
	const childRelocationTargets = $derived.by(() => {
		if (!pendingChildren.length) return [];
		const rootAllowed = pendingChildren.every(
			(child) =>
				!answers.some(
					(sibling) =>
						sibling.parentId === undefined &&
						sibling.id !== child.id &&
						sibling.value.trim().toLocaleLowerCase() === child.value.trim().toLocaleLowerCase()
				)
		);
		return [
			...(rootAllowed ? [{ id: '__root__', label: m.configuration_answer_parent_none() }] : []),
			...answers
				.filter(
					(candidate) =>
						candidate.id !== parent.id &&
						pendingChildren.every(
							(child) =>
								!isAnswerInSubtree(answers, candidate.id, child.id) &&
								!answers.some(
									(sibling) =>
										sibling.id !== child.id &&
										sibling.parentId === candidate.id &&
										sibling.value.trim().toLocaleLowerCase() ===
											child.value.trim().toLocaleLowerCase()
								)
						)
				)
				.map((answer) => ({
					id: answer.id,
					label: answerPathLabel(answers, answer.id)
				}))
		];
	});

	/** Focus moves into the choice when it opens and back to the tree when it closes. */
	function openAt(node: HTMLFieldSetElement) {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const host = node.closest<HTMLElement>('[role="treeitem"]');
		node.querySelector<HTMLElement>('[role="combobox"]')?.focus();
		return () => {
			void tick().then(() => {
				const target = opener?.isConnected ? opener : host?.isConnected ? host : null;
				target?.focus();
			});
		};
	}

	function relocateChildrenAndRemoveParent() {
		const parentId = childRelocationDestination === '__root__' ? '' : childRelocationDestination;
		for (const child of pendingChildren) {
			onMoveAnswer(child.id, parentId);
		}
		onRemoveOption(parent.id);
		onClose();
	}
</script>

<!-- Escape is a container-level key for the controls inside; the fieldset itself is not interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<fieldset
	class="my-1 grid gap-2 rounded-item border border-rule p-3"
	data-testid="parent-removal-choice"
	{@attach openAt}
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		// An open list closes first; the select keeps focus on its trigger, so the key reaches here too.
		if ((event.target as HTMLElement).getAttribute('aria-expanded') === 'true') return;
		event.stopPropagation();
		onClose();
	}}
>
	<legend class="px-1 text-sm font-medium">
		{m.configuration_parent_disposition_title({ name: parent.value })}
	</legend>
	<p class="text-sm text-ink-2">
		{m.configuration_parent_disposition_description({ count: pendingChildren.length })}
	</p>
	<Field.Field>
		<Field.Label for={`${attributeId}-child-destination`}>
			{m.configuration_parent_relocate_label()}
		</Field.Label>
		<ChoiceSelect
			id={`${attributeId}-child-destination`}
			items={childRelocationTargets.map((target) => ({ value: target.id, label: target.label }))}
			bind:value={childRelocationDestination}
			placeholder={m.configuration_parent_choose_destination()}
		/>
	</Field.Field>
	<div class="flex flex-wrap gap-2">
		<Button
			type="button"
			variant="outline"
			disabled={!childRelocationDestination}
			onclick={relocateChildrenAndRemoveParent}
		>
			{m.configuration_parent_relocate_action()}
		</Button>
		<Button
			type="button"
			variant="destructive"
			onclick={() => {
				onRemoveOption(parent.id, true);
				onClose();
			}}
		>
			{m.configuration_parent_remove_branch()}
		</Button>
		<Button type="button" variant="ghost" onclick={onClose}>
			{m.common_cancel()}
		</Button>
	</div>
</fieldset>
