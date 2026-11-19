import { createHash } from "node:crypto";
import { childLink } from "./sessions.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PermissionsState, ScopeMode, Toolset } from "./types.ts";
import { allowsAsk } from "./types.ts";

export const MAX_EXTRA_PATHS = 100;
export const MAX_TOOLSETS = 50;
export const MAX_TOOLSET_PATTERNS = 32;
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
		enabled: false,
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
		version: 3,
		scope: "project",
		extra_paths: [],
		sandboxes: { filesystem: "off", no_network: false },
		toolsets: builtinToolsets(),
		unsandboxed_tools: [],
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
		if (seen.has(entry)) continue;
		seen.add(entry);
		result.push(entry);
		if (result.length >= MAX_EXTRA_PATHS) break;
	}
	return result;
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
		version: 3,
		scope: (source.version === undefined || (typeof source.version === "number" && source.version <= 2))
			&& scope === "project" && extras.length > 0 ? "custom" : scope,
		extra_paths: extras,
		sandboxes: { ...defaults.sandboxes },
		toolsets,
		unsandboxed_tools: readUnsandboxedTools(source.unsandboxed_tools),
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
		// A new session starts from the defaults. The first session after this change
		// also adopts the older shared file once, so an existing setup is not lost.
		if (!existsSync(this.#file)) {
			const marker = join(dirname(statePath()), "permissions", "sessions", ".seeded");
			const legacy = existsSync(statePath()) && !existsSync(marker) ? loadState(statePath()) : defaultState();
			this.#state = legacy;
			try {
				saveState(legacy, this.#file);
				writeFileSync(marker, "", { mode: 0o600 });
			} catch {
				// An unwritable directory keeps the seed in memory only.
			}
			return;
		}
		this.#state = loadState(this.#file);
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
