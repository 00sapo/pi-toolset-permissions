import { createHash } from "node:crypto";

interface SessionIdentity {
	getSessionId(): string;
	getSessionFile?(): string | undefined;
}

// Guarded integration with pi-subagents 0.90. Fleet's disk scanner accepts the
// predecessor IDs in this process-local registry. No host session file is opened.
const SUCCESSION = Symbol.for("pi-subagents.session-succession");
const ALIASES = Symbol.for("pi-toolset-permissions.subagent-alias-owners.v1");
type Runtime = Record<symbol, unknown>;
const hostRuntime = globalThis as unknown as Runtime;

function ownerKey(manager: SessionIdentity): string {
	const key = manager.getSessionFile?.() ?? manager.getSessionId();
	if (!key) throw new Error("The host session identity is unavailable.");
	return key;
}

function aliasFor(key: string): string {
	return `pi-sandbox-${createHash("sha256").update("pi-toolset-permissions.inner-session.v1\0").update(key).digest("hex")}`;
}

/** Stable across executor restarts, without disclosing the host session path. */
export function sandboxSessionId(manager: SessionIdentity): string {
	return aliasFor(ownerKey(manager));
}

function registries(runtime: Runtime): { history: Map<string, string[]>; aliases: Map<string, string> } {
	runtime[SUCCESSION] ??= new Map<string, string[]>();
	runtime[ALIASES] ??= new Map<string, string>();
	const history = runtime[SUCCESSION], aliases = runtime[ALIASES];
	if (!(history instanceof Map) || !(aliases instanceof Map)) throw new Error("Unsupported pi-subagents ownership registry.");
	for (const [key, chain] of history) {
		if (typeof key !== "string" || !Array.isArray(chain) || chain.some(id => typeof id !== "string")) {
			throw new Error("Unsupported pi-subagents ownership registry entry.");
		}
	}
	return { history, aliases };
}

/**
 * Strip synthetic entries before pi-subagents applies its eight-predecessor bound
 * during session replacement. Real lineage remains untouched. Startup discovery
 * restores the aliases after all session_start hooks have finished.
 */
export function unlinkSandboxSessions(runtime: Runtime = hostRuntime): void {
	const { history, aliases } = registries(runtime);
	for (const [key, chain] of history) history.set(key, chain.filter(id => !aliases.has(id)));
}

/** Attach only the current owner's alias and those of its real predecessors. */
export function linkSandboxSession(manager: SessionIdentity, runtime: Runtime = hostRuntime): string {
	const owner = ownerKey(manager);
	const alias = aliasFor(owner);
	const { history, aliases } = registries(runtime);
	// Rebuild from real lineage: reopening A removes A from B's predecessors, so
	// B must lose A's synthetic identity as well, even when sandboxing is now off.
	unlinkSandboxSessions(runtime);
	const chain = history.get(owner) ?? [];
	for (const key of [owner, ...chain]) aliases.set(aliasFor(key), key);
	for (const [key, predecessors] of history) {
		const linked = [key, ...predecessors].flatMap(id => {
			const synthetic = aliasFor(id);
			return aliases.has(synthetic) ? [synthetic] : [];
		});
		history.set(key, [...new Set([...linked, ...predecessors])]);
	}
	if (!history.has(owner)) history.set(owner, [alias]);
	// Keep bookkeeping only for identities still referenced by live history.
	const retained = new Set([...history.values()].flat());
	for (const id of aliases.keys()) if (!retained.has(id)) aliases.delete(id);
	return alias;
}
