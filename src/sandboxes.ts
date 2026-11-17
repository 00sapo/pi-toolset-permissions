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
		description: "Run bash with a read-only filesystem (bubblewrap, or Seatbelt on macOS).",
	},
	{
		key: "no_network",
		label: "No network",
		description: "Run bash without network access (bubblewrap, unshare, or Seatbelt on macOS).",
	},
];

/** External programs a sandbox needs. Tests pass a fixed value. */
export interface SandboxTools {
	/** bubblewrap, Linux. */
	bwrap: string | null;
	/** util-linux unshare, Linux. Network isolation only. */
	unshare: string | null;
	/** Seatbelt, macOS. */
	sandboxExec: string | null;
	shell: string;
	platform: NodeJS.Platform;
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
	const platform = process.platform;
	return {
		bwrap: platform === "linux" ? findExecutable("bwrap") : null,
		unshare: platform === "linux" ? findExecutable("unshare") : null,
		sandboxExec: platform === "darwin" ? findExecutable("sandbox-exec") : null,
		shell: platform === "win32" ? "cmd.exe" : DEFAULT_SHELL,
		platform,
	};
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Seatbelt profile: allow by default, then deny writes and the network. */
export function seatbeltProfile(state: PermissionsState): string {
	const rules = ["(version 1)", "(allow default)"];
	if (state.sandboxes.readonly_bash) {
		rules.push("(deny file-write*)");
		for (const device of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]) {
			rules.push(`(allow file-write* (literal "${device}"))`);
		}
	}
	if (state.sandboxes.no_network) rules.push("(deny network*)");
	return rules.join("");
}

function macOSPlan(command: string, state: PermissionsState, tools: SandboxTools): SandboxPlan {
	if (tools.sandboxExec === null) {
		return {
			error:
				"The sandboxes need sandbox-exec on macOS. It is missing on this system, so the command did not run. Turn the sandbox off in /permissions.",
		};
	}
	const profile = seatbeltProfile(state);
	const inner = `${shellQuote(tools.shell)} -lc ${shellQuote(command)}`;
	return {
		command: `${shellQuote(tools.sandboxExec)} -p ${shellQuote(profile)} ${inner}`,
	};
}

function linuxPlan(command: string, state: PermissionsState, tools: SandboxTools): SandboxPlan {
	const inner = `${shellQuote(tools.shell)} -lc ${shellQuote(command)}`;
	if (tools.bwrap !== null) {
		const bind = state.sandboxes.readonly_bash ? "--ro-bind / /" : "--bind / /";
		const net = state.sandboxes.no_network ? " --unshare-net" : "";
		return {
			command: `${shellQuote(tools.bwrap)} ${bind} --dev /dev --proc /proc${net} --die-with-parent -- ${inner}`,
		};
	}

	if (state.sandboxes.readonly_bash) {
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

/**
 * Wraps a bash command in an OS-level sandbox. No command text is analyzed.
 * Linux uses bubblewrap or unshare, macOS uses Seatbelt, and native Windows is
 * unsupported, so the call fails closed with instructions to use WSL2.
 */
export function wrapBash(
	command: string,
	state: PermissionsState,
	tools: SandboxTools = detectSandboxTools(),
): SandboxPlan {
	if (!state.sandboxes.readonly_bash && !state.sandboxes.no_network) return null;

	if (tools.platform === "win32") {
		return {
			error:
				"Native Windows has no sandbox backend in this extension, so the command did not run. Run pi inside WSL2 to use bubblewrap, or turn the sandbox off in /permissions.",
		};
	}
	if (tools.platform === "darwin") return macOSPlan(command, state, tools);
	if (tools.platform === "linux") return linuxPlan(command, state, tools);

	return {
		error: `The sandboxes are not available on ${tools.platform}, so the command did not run. Turn the sandbox off in /permissions.`,
	};
}
