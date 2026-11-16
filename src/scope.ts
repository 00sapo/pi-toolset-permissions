import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionsState } from "./types.ts";

/** Shell characters that separate one simple command from the next. */
const SEPARATORS = /[;|&()`<>]+/g;

const DIR_COMMANDS = new Set(["cd", "pushd"]);

/** Device paths that never leave the project scope in practice. */
const HARMLESS_DEVICE_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

export function stripAt(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

export function resolvePath(cwd: string, value: string): string {
	return resolve(cwd, expandHome(stripAt(value)));
}

/** Resolves symlinks in the deepest existing ancestor, then reattaches the rest. */
export function canonicalPath(value: string): string {
	const absolute = resolve(value);
	let current = absolute;
	const tail: string[] = [];
	for (;;) {
		try {
			const base = realpathSync(current);
			return tail.length === 0 ? base : join(base, ...tail);
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolute;
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

export function isInside(root: string, target: string): boolean {
	const canonicalRoot = canonicalPath(root);
	const canonicalTarget = canonicalPath(target);
	if (canonicalRoot === canonicalTarget) return true;
	const rest = relative(canonicalRoot, canonicalTarget);
	if (rest === "" || rest === ".." || isAbsolute(rest)) return false;
	return !rest.startsWith(`..${sep}`);
}

export function isAllowedPath(state: PermissionsState, cwd: string, value: string): boolean {
	if (state.scope === "everywhere") return true;
	const target = canonicalPath(resolvePath(cwd, value));
	if (isInside(cwd, target)) return true;
	return state.extra_paths.some((entry) => isInside(entry, target));
}

/** Resolve a user-supplied path and check that it is an existing directory. */
export function resolveDirectory(cwd: string, value: string): { path: string } | { error: string } {
	const trimmed = value.trim();
	if (trimmed === "") return { error: "The path is empty." };
	const resolved = resolvePath(cwd, trimmed);
	if (!isAbsolute(resolved)) return { error: `${resolved} is not an absolute path.` };
	try {
		if (!statSync(resolved).isDirectory()) return { error: `${resolved} is not a directory.` };
	} catch {
		return { error: `${resolved} does not exist.` };
	}
	// Return the canonical path so a symlink cannot grant a larger tree than the dialog names.
	return { path: canonicalPath(resolved) };
}

function unquote(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
	}
	return token;
}

function tokensOf(command: string): string[] {
	return command
		.replace(SEPARATORS, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

/** Splits `--flag=value` into the value part. A bare `NAME=value` is not a path. */
function candidatesOf(token: string): string[] {
	const value = unquote(token);
	const index = value.indexOf("=");
	if (index > 0) {
		const head = value.slice(0, index);
		const rest = value.slice(index + 1);
		if (head.startsWith("-")) return rest.length > 0 ? [rest] : [];
	}
	return [value];
}

function isPathLike(token: string): boolean {
	if (token.includes("://")) return false;
	if (token.startsWith("-")) return token.includes("/");
	if (token.startsWith(".") || token.startsWith("~")) return true;
	return token.includes("/");
}

/** True when the token at `index` is the directory argument of `cd` or `pushd`. */
function isDirArgument(tokens: string[], index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const word = unquote(tokens[i]);
		if (word.startsWith("-")) continue;
		return DIR_COMMANDS.has(word);
	}
	return false;
}

/** Returns unique absolute candidate paths found in a shell command line. */
export function scanBashPaths(command: string, cwd: string): string[] {
	const tokens = tokensOf(command);
	const found: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const forced = isDirArgument(tokens, i);
		const token = tokens[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		for (const candidate of candidatesOf(token)) {
			if (candidate.length === 0) continue;
			if (candidate.startsWith("-") && !candidate.includes("/")) continue;
			if (!forced && !isPathLike(candidate)) continue;
			if (candidate.includes("://")) continue;
			const absolute = resolvePath(cwd, candidate);
			if (HARMLESS_DEVICE_PATHS.has(absolute)) continue;
			if (seen.has(absolute)) continue;
			seen.add(absolute);
			found.push(absolute);
		}
	}
	return found;
}

export function outsidePaths(state: PermissionsState, cwd: string, values: string[]): string[] {
	return values.filter((value) => !isAllowedPath(state, cwd, value));
}
