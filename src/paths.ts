/** Path rules that the scope, the state, and the sandboxes share. Pure: no runtime imports. */

/** True when `root` is `path` or contains it. `/` contains every path. */
export function containsPath(root: string, path: string): boolean {
	return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** Trees that the sandbox binds read-only on its own, so a nested path is already visible. */
export const SYSTEM_TREES = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];

/**
 * Trees that the sandbox mounts empty and then fills with its own entries. A nested host
 * path stays invisible until a bind puts it back, and the executor owns slots in both.
 */
export const REPRODUCIBLE_TREES = ["/etc", "/run"];

/**
 * Trees that a bind must not enter. The pseudo filesystems own their nodes, and `/run` and
 * `/etc` carry the control socket, the relay links, and the generated account files.
 */
export const REFUSED_TREES = ["/proc", "/dev", "/sys"];

/** Every tree that the sandbox owns or binds itself. */
export const PROTECTED_ROOTS = [...REFUSED_TREES, ...SYSTEM_TREES, ...REPRODUCIBLE_TREES];

/** Slots below `/run` that the executor creates for the control socket and the relay. */
export const RESERVED_RUN_NAMES = ["pi-bin", "pi-bridge", "pi-agent", "pi-agent-private", "pi-home"];

/** `/etc` files that the relay generates, so a host bind there would be overwritten. */
export const GENERATED_ETC = ["passwd", "group"];

/** True when a path overlaps a protected tree in either direction. */
export function overlapsProtectedRoot(path: string): boolean {
	return PROTECTED_ROOTS.some((own) => containsPath(own, path) || containsPath(path, own));
}

/** True when the sandbox owns this path or binds it itself, so a plain host bind cannot take it. */
export function reservedForSandbox(path: string): boolean {
	return PROTECTED_ROOTS.some((own) => containsPath(own, path));
}

/**
 * How a sandbox can place a host path.
 *
 * `free` binds it at the same path. `covered` is already visible, because the sandbox binds
 * that tree read-only, so no bind is needed and nothing is lost. `reproducible` sits inside
 * a tree that the sandbox mounts empty, so a bind puts that part back in view. `refused`
 * cannot be placed: the path is a whole private tree, a pseudo filesystem node, a control
 * slot, or a generated file.
 */
export type PathPlacement = "free" | "covered" | "reproducible" | "refused";

/**
 * The placement for a host path.
 *
 * A whole protected tree is always refused. Binding `/run` would replace the control socket,
 * the relay links, and the agent directories, and binding `/etc` would show the host accounts
 * and overwrite the generated ones. A path inside such a tree is reproducible, because the
 * bind restores only the part that the work needs and the sandbox keeps owning the rest.
 */
export function classifyPlacement(path: string): PathPlacement {
	if (path === "/" || REFUSED_TREES.some((tree) => containsPath(tree, path))) return "refused";
	if (SYSTEM_TREES.some((tree) => containsPath(tree, path))) return "covered";
	const tree = REPRODUCIBLE_TREES.find((own) => containsPath(own, path));
	if (tree === undefined) return "free";
	if (path === tree) return "refused";
	const parts = path.slice(1).split("/");
	// The relay writes these entries itself, so a host bind there would be overwritten.
	if (tree === "/etc" && parts.length === 2 && GENERATED_ETC.includes(parts[1])) return "refused";
	// The executor creates these slots, so a host bind there would hide its own files.
	if (tree === "/run" && RESERVED_RUN_NAMES.includes(parts[1])) return "refused";
	return "reproducible";
}
