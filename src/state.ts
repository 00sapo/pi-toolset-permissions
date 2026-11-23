import { createHash } from "node:crypto";
import { childLink } from "./sessions.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PermissionsState, SandboxMount, ScopeMode, Toolset } from "./types.ts";
import { allowsAsk } from "./types.ts";
import { classifyPlacement } from "./paths.ts";

export const MAX_EXTRA_PATHS = 100;
export const MAX_TOOLSETS = 50;
export const MAX_TOOLSET_PATTERNS = 32;
export const MAX_MOUNTS = 16;
const MAX_PATTERN_LENGTH = 500;

/** The toolsets that the extension ships. `write` starts off. */
const SHIPPED: ReadonlyArray<{ name: string; enabled: boolean; patterns: string[] }> = [
	{
		name: "read",
		enabled: true,
		patterns: [
			"^(read|ls|find|grep|tool_search)$",
			"^hypa_(read|ls|find|grep)$",
			"^(read|list|search|get)_",
			"_(read|list|grep)$",
		],
	},
	{
		name: "write",
		enabled: true,
		patterns: [
			"^(write|edit)$",
			"^hypa_(write|edit)$",
			"^(write|edit|patch|apply)_",
			"_(write|edit|patch)$",
		],
	},
	{
		name: "execute",
		enabled: true,
		patterns: [
			"^(bash|powershell|codemode)$",
			"^hypa_(shell|bash|exec|run|powershell)$",
			"^(bash|shell|exec|run|spawn)_",
			"_(bash|shell|exec)$",
		],
	},
	{
		// The delegation tools of pi-subagents. They are their own group, so a user can
		// block delegation without turning off the file tools that a child also needs.
		name: "subagent",
		enabled: true,
		// Delegation only. ask_parent and notify_parent keep their own channel, so a child
		// reaches its parent whatever this toolset says.
		patterns: ["^(Agent|subagent|agent|get_subagent_result|steer_subagent)$"],
	},
	{
		// The permissions toolset holds the permissions tool. It is a normal toolset, so the
		// model and the screen can turn it off.
		name: "permissions",
		enabled: true,
		patterns: ["^permissions$"],
	},
];

let tempCounter = 0;

function builtinToolsets(): Toolset[] {
	return SHIPPED.map((entry) => ({
		name: entry.name,
		patterns: [...entry.patterns],
		enabled: entry.enabled,
		builtin: true,
	}));
}

export function defaultState(): PermissionsState {
	return {
		version: 4,
		scope: "project",
		extra_paths: [],
		sandboxes: { filesystem: "off", no_network: false },
		toolsets: builtinToolsets(),
		unsandboxed_tools: [],
		sandbox_mounts: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compiles(pattern: string): boolean {
	try {
		new RegExp(pattern, "i");
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks a list of regular expression sources. Returns the accepted list in order, or
 * the first error. Both the state file and the pattern editor use this function, so a
 * saved list always loads again.
 */
export function checkPatterns(raw: unknown[], allowEmpty = false): { patterns: string[] } | { error: string } {
	const patterns: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") return { error: "A pattern must be text." };
		const source = value.trim();
		if (source === "") return { error: "A pattern is empty." };
		if (source.length > MAX_PATTERN_LENGTH) {
			return { error: `A pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
		}
		if (!compiles(source)) return { error: `The pattern ${source} does not compile.` };
		patterns.push(source);
		if (patterns.length >= MAX_TOOLSET_PATTERNS) break;
	}
	if (patterns.length === 0 && !allowEmpty) return { error: "A toolset needs at least one pattern." };
	return { patterns };
}

function readScope(value: unknown): ScopeMode | null {
	return value === "project" || value === "everywhere" || value === "custom" ? value : null;
}

function readExtraPaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !isAbsolute(entry)) continue;
		// A root that the sandbox cannot place would fail at launch, and that would remove
		// every sandboxed tool from the session. Resolve the links first, so a hand-edited
		// entry cannot hide such a path behind a link. A path that the sandbox reproduces,
		// such as `/run/user/1000`, stays, because the launch puts it back in view.
		let path = entry;
		try {
			path = realpathSync(entry);
		} catch {
			// A missing path keeps its stored value. The launch skips it.
		}
		if (seen.has(path) || classifyPlacement(path) === "refused") continue;
		seen.add(path);
		result.push(path);
		if (result.length >= MAX_EXTRA_PATHS) break;
	}
	return result;
}

/**
 * Directories that the sandbox cannot mount: they belong to the sandbox itself, so a
 * host path there would replace the private one. The launcher refuses them too.
 */
const PROTECTED_MOUNT_ROOTS = ["/run", "/proc", "/dev", "/sys", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64"];

/** True when the sandbox mounts this path itself, so a custom mount must not replace it. */
export function isProtectedMountPath(path: string): boolean {
	return PROTECTED_MOUNT_ROOTS.some((own) => path === own || path.startsWith(`${own}/`));
}

/**
 * Reads the custom mounts. A missing or malformed entry is dropped, and so is a path that
 * does not exist as a file or a directory, or that overlaps the sandbox itself. A stale entry must
 * never stop the extension from loading or open a path that the launcher cannot mount.
 */
function readMounts(value: unknown): SandboxMount[] {
	if (!Array.isArray(value)) return [];
	const found: SandboxMount[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const raw = entry.path;
		if (typeof raw !== "string" || !isAbsolute(raw)) continue;
		let path = raw;
		try {
			const stats = statSync(raw);
			if (!stats.isFile() && !stats.isDirectory()) continue;
			path = realpathSync(raw);
		} catch {
			continue;
		}
		if (isProtectedMountPath(path) || seen.has(path)) continue;
		seen.add(path);
		found.push({ path, writable: entry.writable === true });
		if (found.length >= MAX_MOUNTS) break;
	}
	return found;
}

/** Reads the sandbox exception list. An empty list is valid and means no exception. */
function readUnsandboxedTools(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const checked = checkPatterns(value, true);
	return "error" in checked ? [] : checked.patterns;
}

/** A stored mode, with ask refused for a toolset that supports only on and off. */
function readMode(name: string, value: unknown): boolean | "ask" {
	return value === "ask" && allowsAsk(name) ? "ask" : value !== false;
}

function readToolset(entry: unknown): Toolset | null {
	if (!isRecord(entry)) return null;
	const name = typeof entry.name === "string" ? entry.name.trim() : "";
	if (name.length === 0) return null;
	if (!Array.isArray(entry.patterns)) return null;

	const checked = checkPatterns(entry.patterns);
	if ("error" in checked) return null;

	return { name, patterns: checked.patterns, enabled: readMode(name, entry.enabled), builtin: false };
}

/** Reads the stored toolsets in file order. A duplicate name keeps the first entry. */
function readStoredToolsets(value: unknown): Map<string, Toolset> {
	const stored = new Map<string, Toolset>();
	if (!Array.isArray(value)) return stored;
	for (const entry of value) {
		const toolset = readToolset(entry);
		if (toolset === null) continue;
		const key = toolset.name.toLowerCase();
		if (stored.has(key)) continue;
		stored.set(key, toolset);
		if (stored.size >= MAX_TOOLSETS) break;
	}
	return stored;
}

/** Accepts unknown JSON and returns a valid state, repaired against the defaults. */
export function mergeState(raw: unknown): PermissionsState {
	const defaults = defaultState();
	const source: Record<string, unknown> = isRecord(raw) ? raw : {};
	const stored = readStoredToolsets(source.toolsets);
	// Migrate the old builtin name without changing its mode or patterns.
	const legacy = stored.get("permission");
	if (legacy !== undefined) {
		if (!stored.has("permissions")) stored.set("permissions", { ...legacy, name: "permissions" });
		stored.delete("permission");
	}

	// A shipped toolset keeps its name and its builtin mark. The file sets the on/off
	// state and the pattern list, so a user can tune the default patterns.
	const toolsets = defaults.toolsets.map((toolset) => {
		const key = toolset.name.toLowerCase();
		const saved = stored.get(key);
		if (saved === undefined) return toolset;
		stored.delete(key);
		return { ...toolset, patterns: saved.patterns, enabled: saved.enabled };
	});
	for (const toolset of stored.values()) {
		if (toolsets.length >= MAX_TOOLSETS) break;
		toolsets.push(toolset);
	}

	const extras = readExtraPaths(source.extra_paths);
	const scope = readScope(source.scope) ?? defaults.scope;
	const state: PermissionsState = {
		version: 4,
		scope: (source.version === undefined || (typeof source.version === "number" && source.version <= 2))
			&& scope === "project" && extras.length > 0 ? "custom" : scope,
		extra_paths: extras,
		sandboxes: { ...defaults.sandboxes },
		toolsets,
		unsandboxed_tools: readUnsandboxedTools(source.unsandboxed_tools),
		sandbox_mounts: readMounts(source.sandbox_mounts),
	};

	const sandboxes = isRecord(source.sandboxes) ? source.sandboxes : {};
	if (typeof sandboxes.no_network === "boolean") state.sandboxes.no_network = sandboxes.no_network;
	if (state.scope !== "everywhere") {
		if (sandboxes.filesystem === "off" || sandboxes.filesystem === "read" || sandboxes.filesystem === "read+write") {
			state.sandboxes.filesystem = sandboxes.filesystem;
		} else if (!("filesystem" in sandboxes) && sandboxes.readonly_bash === true) {
			state.sandboxes.filesystem = "read";
		} else if ("filesystem" in sandboxes) {
			// An unknown value, such as one from a later version, must not open the host
			// filesystem. Fall back to the restrictive state and keep the layers consistent.
			state.sandboxes.filesystem = "read";
		}
	}

	return state;
}

export function statePath(): string {
	const override = process.env.PI_PERMISSIONS_FILE;
	if (override !== undefined && override.length > 0) return override;
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(resolve(dir), "permissions.json");
}

/** Returns the defaults when the file is missing or unparseable. */
export function loadState(file?: string): PermissionsState {
	const target = file ?? statePath();
	let text: string;
	try {
		text = readFileSync(target, "utf8");
	} catch {
		return defaultState();
	}
	try {
		return mergeState(JSON.parse(text));
	} catch {
		return defaultState();
	}
}

/** Writes through a temp file in the target directory, then renames it. */
export function saveState(state: PermissionsState, file?: string): void {
	const target = file ?? statePath();
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	tempCounter += 1;
	const temp = join(dir, `.${basename(target)}.${process.pid}.${tempCounter}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export class StateStore {
	#file: string;
	#state: PermissionsState;
	#explicit: boolean;
	#listeners: Array<(state: PermissionsState) => void> = [];

	constructor(file?: string) {
		this.#explicit = file !== undefined || Boolean(process.env.PI_PERMISSIONS_FILE);
		this.#file = file ?? statePath();
		this.#state = loadState(this.#file);
	}

	/** The file that new sessions start from, and that `save_defaults` writes. */
	get defaultsFile(): string {
		return statePath();
	}

	/** Each root session owns a persistent file. Children share the parent policy. */
	bindSession(sessionId: string): void {
		if (this.#explicit || !sessionId) return;
		let root = sessionId;
		const seen = new Set<string>();
		while (childLink(root) && !seen.has(root)) {
			seen.add(root);
			root = childLink(root)!.parentSessionId;
		}
		const key = createHash("sha256").update(root).digest("hex");
		this.#file = join(dirname(statePath()), "permissions", "sessions", `${key}.json`);
		// A new session starts from the template, so a choice that the user saved for
		// every session also seeds the next one. Without a template it starts from the
		// shipped defaults.
		if (!existsSync(this.#file)) {
			const seed = existsSync(this.defaultsFile) ? loadState(this.defaultsFile) : defaultState();
			this.#state = seed;
			try {
				saveState(seed, this.#file);
			} catch {
				// An unwritable directory keeps the seed in memory only.
			}
			return;
		}
		this.#state = loadState(this.#file);
	}

	/**
	 * Copies the current session state into the template file. The session keeps its own
	 * file, so this changes what a new session starts from and nothing else.
	 */
	saveDefaults(): void {
		// The session may have changed on disk since the last read.
		const current = this.#explicit ? this.#state : loadState(this.#file);
		saveState(current, this.defaultsFile);
	}

	get(): PermissionsState {
		return this.#state;
	}

	update(mutator: (current: PermissionsState) => PermissionsState): PermissionsState {
		// Rebase on the file so a second pi process does not lose a change.
		const next = mergeState(mutator(loadState(this.#file)));
		saveState(next, this.#file);
		this.#state = next;
		for (const listener of this.#listeners) listener(next);
		return next;
	}

	/** Reloads from disk, for example after the file changed outside the session. */
	reload(): PermissionsState {
		this.#state = loadState(this.#file);
		return this.#state;
	}

	onChange(listener: (state: PermissionsState) => void): void {
		this.#listeners.push(listener);
	}
}
