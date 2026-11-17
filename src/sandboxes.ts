import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { PermissionsState, SandboxFlags } from "./types.ts";

export interface SandboxInfo {
	key: keyof SandboxFlags;
	label: string;
	description: string;
}

export const SANDBOXES: SandboxInfo[] = [
	{
		key: "readonly_bash",
		label: "Read-only filesystem",
		description: "Run bash in a read-only view of the filesystem (needs bubblewrap).",
	},
	{
		key: "no_network",
		label: "No network",
		description: "Run bash without network access (needs bubblewrap or unshare).",
	},
];

/** External programs a sandbox needs. Tests pass a fixed value. */
export interface SandboxTools {
	bwrap: string | null;
	unshare: string | null;
	shell: string;
}

/** A command to run, an error to report, or null when no sandbox is on. */
export type SandboxPlan = { command: string } | { error: string } | null;

const DEFAULT_SHELL = "/bin/sh";

/** Looks up an executable in PATH without starting a process. */
export function findExecutable(name: string, pathValue = process.env.PATH ?? ""): string | null {
	for (const dir of pathValue.split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here. Try the next directory.
		}
	}
	return null;
}

export function detectSandboxTools(): SandboxTools {
	return {
		bwrap: findExecutable("bwrap"),
		unshare: findExecutable("unshare"),
		shell: DEFAULT_SHELL,
	};
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wraps a bash command in an OS-level sandbox. The read-only sandbox binds the root
 * read-only, so any write fails at the kernel. The no-network sandbox unshares the
 * network namespace. No command text is analyzed.
 */
export function wrapBash(
	command: string,
	state: PermissionsState,
	tools: SandboxTools = detectSandboxTools(),
): SandboxPlan {
	const { readonly_bash, no_network } = state.sandboxes;
	if (!readonly_bash && !no_network) return null;

	const inner = `${shellQuote(tools.shell)} -lc ${shellQuote(command)}`;
	if (tools.bwrap !== null) {
		const bind = readonly_bash ? "--ro-bind / /" : "--bind / /";
		const net = no_network ? " --unshare-net" : "";
		return {
			command: `${shellQuote(tools.bwrap)} ${bind} --dev /dev --proc /proc${net} --die-with-parent -- ${inner}`,
		};
	}

	if (readonly_bash) {
		return {
			error:
				"The read-only filesystem sandbox needs bubblewrap (bwrap). Install bubblewrap, or turn the sandbox off in /permissions.",
		};
	}

	if (tools.unshare !== null) {
		return { command: `${shellQuote(tools.unshare)} -n -- ${inner}` };
	}

	return {
		error:
			"The no-network sandbox needs bubblewrap (bwrap) or unshare. Install one, or turn the sandbox off in /permissions.",
	};
}
