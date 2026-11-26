/**
 * The relay serves one virtual model to the inner Pi. Every assistant message that it
 * forwards must name that model, not the outer model that produced it.
 *
 * A delegated tool can inspect the answer identity. Pi-subagents checks that a child
 * reports the model that the caller asked for, so the outer id would fail the check.
 * The relay is the model that the inner session selects, so its id is the honest answer.
 */
export const RELAY_PROVIDER = "sandbox-parent";
export const RELAY_MODEL = "parent";

function relabel(value: unknown, provider: string, model: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const message = value as Record<string, unknown>;
	if (message.role !== "assistant") return value;
	return { ...message, api: provider, provider, model };
}

/** Copy one streamed assistant event with the relay identity on the messages it carries. */
export function relayEvent<T>(event: T): T {
	if (!event || typeof event !== "object" || Array.isArray(event)) return event;
	const record = event as Record<string, unknown>;
	const copy: Record<string, unknown> = { ...record };
	for (const key of ["message", "partial", "error"]) {
		if (record[key] !== undefined) copy[key] = relabel(record[key], RELAY_PROVIDER, RELAY_MODEL);
	}
	return copy as T;
}
