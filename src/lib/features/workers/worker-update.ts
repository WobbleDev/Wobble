/**
 * A Worker as the whole-record update shape, the shape a stored draft holds (ADR-0023).
 *
 * Every configured Attribute appears, even one the Worker holds no value for: the
 * record panel builds a draft's `update` and `base` from this same call, so a value
 * that reaches a Worker Attribute must land in both. A draft missing an Attribute
 * would let its older snapshot clear the saved value on the next draft save.
 */
import {
	emptyValue,
	type Worker,
	type WorkerAttributeDefinition,
	type WorkerUpdate
} from '#lib/domain-vocabulary.ts';

export function toWorkerUpdate(
	worker: Worker,
	attributes: readonly WorkerAttributeDefinition[]
): WorkerUpdate {
	return {
		name: worker.name,
		email: worker.email,
		phone: worker.phone,
		assessment: worker.assessment,
		attributes: Object.fromEntries(
			attributes.map((attribute) => [
				attribute.id,
				worker.attributes[attribute.id] ?? emptyValue(attribute.kind)
			])
		),
		agitations: [...worker.agitations],
		languages: [...worker.languages],
		relationships: [...worker.relationships],
		notes: worker.notes.map((note) => ({ ...note }))
	};
}
