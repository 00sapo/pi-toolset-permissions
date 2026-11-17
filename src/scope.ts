import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionsState } from "./types.ts";

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

