import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PermissionsState, Risk, SandboxFlags, ScopeMode, Toolset } from "./types.ts";

const RISKS: Risk[] = ["read", "write", "execute"];

export const MAX_EXTRA_PATHS = 100;
export const MAX_TOOLSETS = 50;
const MAX_TOOLSET_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 500;

const SANDBOX_KEYS: Array<keyof SandboxFlags> = ["readonly_bash", "no_network"];

const BUILTIN_PATTERNS: Record<Risk, string[]> = {
	read: [
		"^(read|ls|find|grep|tool_search)$",
		"^hypa_(read|ls|find|grep)$",
		"^(read|list|search|get)_",
		"_(read|list|grep)$",
	],
	write: [
		"^(write|edit)$",
		"^hypa_(write|edit)$",
		"^(write|edit|patch|apply)_",
		"_(write|edit|patch)$",
	],
	execute: [
		"^(bash|powershell|codemode)$",
		"^hypa_(shell|bash|exec|run|powershell)$",
		"^(bash|shell|exec|run|spawn)_",
		"_(bash|shell|exec)$",
	],
};

let tempCounter = 0;

function builtinToolsets(): Toolset[] {
	return RISKS.map((risk) => ({
		name: risk,
		risk,
		patterns: [...BUILTIN_PATTERNS[risk]],
		enabled: true,
		builtin: true,
	}));
}

export function defaultState(): PermissionsState {
	return {
		version: 1,
		flags: { read: true, write: false, execute: true },
		scope: "project",
		extra_paths: [],
		sandboxes: { readonly_bash: false, no_network: false },
		toolsets: builtinToolsets(),
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

function readScope(value: unknown): ScopeMode | null {
	return value === "project" || value === "everywhere" ? value : null;
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

function readToolset(entry: unknown): Toolset | null {
	if (!isRecord(entry)) return null;
	const name = typeof entry.name === "string" ? entry.name.trim() : "";
	if (name.length === 0) return null;
	const risk = entry.risk;
	if (risk !== "read" && risk !== "write" && risk !== "execute") return null;
	if (!Array.isArray(entry.patterns)) return null;

	const patterns: string[] = [];
	for (const pattern of entry.patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) return null;
		if (pattern.length > MAX_PATTERN_LENGTH) return null;
		if (!compiles(pattern)) return null;
		patterns.push(pattern);
		if (patterns.length >= MAX_TOOLSET_PATTERNS) break;
	}
	if (patterns.length === 0) return null;

	return { name, risk, patterns, enabled: entry.enabled !== false, builtin: false };
}

function readCustomToolsets(value: unknown, builtins: Toolset[]): Toolset[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set(builtins.map((toolset) => toolset.name.toLowerCase()));
	const limit = Math.max(0, MAX_TOOLSETS - builtins.length);
	const result: Toolset[] = [];
	for (const entry of value) {
		const toolset = readToolset(entry);
		if (toolset === null) continue;
		const key = toolset.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(toolset);
		if (result.length >= limit) break;
	}
	return result;
}

/** Accepts unknown JSON and returns a valid state, repaired against the defaults. */
export function mergeState(raw: unknown): PermissionsState {
	const defaults = defaultState();
	const source: Record<string, unknown> = isRecord(raw) ? raw : {};
	const state: PermissionsState = {
		version: 1,
		flags: { ...defaults.flags },
		scope: readScope(source.scope) ?? defaults.scope,
		extra_paths: readExtraPaths(source.extra_paths),
		sandboxes: { ...defaults.sandboxes },
		toolsets: [],
	};

	const flags = isRecord(source.flags) ? source.flags : {};
	for (const risk of RISKS) {
		const value = flags[risk];
		if (typeof value === "boolean") state.flags[risk] = value;
	}

	const sandboxes = isRecord(source.sandboxes) ? source.sandboxes : {};
	for (const key of SANDBOX_KEYS) {
		const value = sandboxes[key];
		if (typeof value === "boolean") state.sandboxes[key] = value;
	}

	state.toolsets = [...defaults.toolsets, ...readCustomToolsets(source.toolsets, defaults.toolsets)];
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
	#listeners: Array<(state: PermissionsState) => void> = [];

	constructor(file?: string) {
		this.#file = file ?? statePath();
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
