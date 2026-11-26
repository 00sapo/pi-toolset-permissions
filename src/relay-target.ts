/**
 * The model that a sandboxed tool asked for, resolved against the host registry.
 *
 * The sandbox exposes one relay model, so the inner Pi can only select that one.
 * The tool that the caller invoked still names its own model, and the outer session
 * is the only side that holds that catalogue and its credentials. This module turns
 * the requested reference into the host model that the relay streams, without
 * copying any catalogue into the sandbox.
 */

/** The parts of a `provider/id` reference. A missing provider leaves the id whole. */
export function parseModelRef(ref: string | undefined): { provider?: string; id: string } | undefined {
	const trimmed = ref?.trim();
	if (!trimmed) return undefined;
	// A thinking suffix selects a level, not a different model.
	const base = trimmed.replace(/:(off|minimal|low|medium|high|xhigh|max)$/u, "");
	const slash = base.indexOf("/");
	if (slash <= 0 || slash === base.length - 1) return { id: base };
	return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
}

interface ModelLookup<Model> {
	find(provider: string, id: string): Model | undefined;
}

/**
 * The host model for a requested reference, or the fallback when the reference is
 * absent, unqualified, or unknown to this host. An unknown model is reported by the
 * caller through its normal error path, so this returns the fallback instead of
 * throwing inside a stream.
 */
export function resolveRelayTarget<Model>(
	registry: ModelLookup<Model>,
	ref: string | undefined,
	fallback: Model | undefined,
): Model | undefined {
	const parsed = parseModelRef(ref);
	if (!parsed?.provider) return fallback;
	return registry.find(parsed.provider, parsed.id) ?? fallback;
}
