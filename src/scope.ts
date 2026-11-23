import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionsState } from "./types.ts";
import { classifyPlacement } from "./paths.ts";

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

/** Pure string containment, with no link resolution. */
function isInsideLexical(root: string, target: string): boolean {
	const absoluteRoot = resolve(root);
	const absoluteTarget = resolve(target);
	if (absoluteRoot === absoluteTarget) return true;
	const rest = relative(absoluteRoot, absoluteTarget);
	if (rest === "" || rest === ".." || isAbsolute(rest)) return false;
	return !rest.startsWith(`..${sep}`);
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
	// A normalized path inside the project is allowed before link resolution, so a
	// link in the project can reach its target. The link itself is the project path.
	if (isInsideLexical(cwd, resolvePath(cwd, value))) return true;
	const target = canonicalPath(resolvePath(cwd, value));
	if (isInside(cwd, target)) return true;
	return state.scope === "custom" && state.extra_paths.some((entry) => isInside(entry, target));
}

/** Resolve a user-supplied path and check that it exists as a file or a directory. */
export function resolveExistingPath(cwd: string, value: string): { path: string } | { error: string } {
	const trimmed = value.trim();
	if (trimmed === "") return { error: "The path is empty." };
	const resolved = resolvePath(cwd, trimmed);
	if (!isAbsolute(resolved)) return { error: `${resolved} is not an absolute path.` };
	try {
		if (!statSync(resolved).isFile() && !statSync(resolved).isDirectory()) return { error: `${resolved} is not a file or a directory.` };
	} catch {
		return { error: `${resolved} does not exist.` };
	}
	return { path: canonicalPath(resolved) };
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


/** Roots selected by the scope mode. Everywhere has no path boundary. */
export function scopeRoots(state: PermissionsState, cwd: string): string[] {
	return state.scope === "everywhere" ? ["/"] : state.scope === "custom" ? [cwd, ...state.extra_paths] : [cwd];
}

/**
 * Existing external targets reachable through project links, with cycle protection.
 *
 * A target that the sandbox cannot place is left out. A target inside `/etc` or `/run` is
 * kept, because the sandbox mounts those trees empty and a bind puts the target back in
 * view. A target inside a system tree is left out, because that tree is already visible
 * read-only. A virtual environment links its interpreter to `/usr/bin/python3.13`, so this
 * case is ordinary, and walking `/usr` would only cost time.
 */
export function projectLinkTargets(cwd: string): string[] {
 const project = canonicalPath(cwd);
 const visited = new Set<string>();
 const targets = new Set<string>();
 const walk = (directory: string): void => {
  let real: string;
  try { real = realpathSync(directory); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  let entries;
  try { entries = readdirSync(real, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
   const path = join(real, entry.name);
   if (entry.isSymbolicLink()) {
    try {
     const target = realpathSync(path);
     const info = statSync(target);
     if (!info.isFile() && !info.isDirectory()) continue;
     // A path that cannot be placed adds nothing, and a covered one is already visible. A
     // reproduced directory is bound as a whole, so its children need no entries of their
     // own. Walking any of these trees would only spend time and add noise.
     const placement = classifyPlacement(target);
     if (placement === "covered" || placement === "refused") continue;
     if (!isInsideLexical(project, target)) targets.add(target);
     if (info.isDirectory() && placement === "free") walk(target);
    } catch {
     // Broken links grant no parent directory access.
    }
   } else if (entry.isDirectory()) walk(path);
  }
 };
 walk(project);
 return [...targets].sort();
}

/** Sandbox roots include project links, but not links in unrelated custom roots. */
export function sandboxRoots(state: PermissionsState, cwd: string): string[] {
 const roots = scopeRoots(state, cwd);
 return state.scope === "everywhere" ? roots : [...new Set([...roots, ...projectLinkTargets(cwd)])];
}
