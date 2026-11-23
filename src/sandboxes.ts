import { sandboxRoots } from "./scope.ts";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { accountFiles, classifyRoots, containsPath, etcMounts, gitDirectories, systemMounts } from "./isolated-launcher.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import type { PermissionsState, SandboxFlags } from "./types.ts";

export interface SandboxInfo {
	key: keyof SandboxFlags;
	label: string;
	description: string;
}

export const SANDBOXES: SandboxInfo[] = [
	{
		key: "filesystem",
		label: "Filesystem",
		description: "Limit filesystem access to the roots selected by Scope. Read permits reads only. Read+write permits reads and writes.",
	},
	{
		key: "no_network",
		label: "Network",
		// The row label names the subject, so the value names what the layer allows.
		description: "Allow or forbid network access for the sandboxed tools (bubblewrap, unshare, or Seatbelt on macOS).",
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

/** Restrict reads and writes to explicit roots and runtime paths. */
export function seatbeltProfile(state: PermissionsState, cwd = process.cwd()): string {
 const rules = ["(version 1)", "(allow default)"];
 if (state.sandboxes.filesystem !== "off") {
  const classified = classifyRoots(sandboxRoots(state, cwd));
  const roots = classified.roots;
  const quote = (path: string) => JSON.stringify(path);
  // Seatbelt hides nothing by default, so a reproducible path is already in view. It only
  // needs the read rule, and the write rule when the layer allows writes.
  for (const path of classified.reproduced) {
   roots.push(path);
  }
  rules.push("(deny file-read*)", "(deny file-write*)");
  for (const root of roots) {
   rules.push(`(allow file-read* (subpath ${quote(root)}))`);
   if (state.sandboxes.filesystem === "read+write") rules.push(`(allow file-write* (subpath ${quote(root)}))`);
  }
  for (const path of ["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/Library/Frameworks", "/private/etc/ssl", "/private/var/db/dyld"]) {
   rules.push(`(allow file-read* (subpath ${quote(path)}))`);
  }
  const executableDirs = new Set([dirname(realpathSync(process.execPath))]);
  const pi = findExecutable("pi");
  if (pi) executableDirs.add(dirname(realpathSync(pi)));
  for (const path of executableDirs) rules.push(`(allow file-read* (subpath ${quote(path)}))`);
  const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  for (const file of ["settings.json", "models.json"]) rules.push(`(allow file-read* (literal ${quote(join(agent,file))}))`);
  rules.push(`(allow file-read* file-write* (subpath ${quote(join(agent,"sessions"))}))`);
  rules.push(`(allow file-read* file-write* (literal ${quote(join(agent,"settings.json"))}))`);
  for (const path of ["/private/etc/localtime", "/private/etc/resolv.conf", "/private/etc/hosts", "/dev/null", "/dev/urandom", "/dev/random", "/dev/tty"]) {
   rules.push(`(allow file-read* (literal ${quote(path)}))`);
  }
  for (const path of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]) rules.push(`(allow file-write* (literal ${quote(path)}))`);
 }
 if (state.sandboxes.no_network) rules.push("(deny network*)");
 return rules.join("");
}

function macOSPlan(command: string, state: PermissionsState, tools: SandboxTools, cwd: string): SandboxPlan {
	if (tools.sandboxExec === null) {
		return {
			error:
				"The sandboxes need sandbox-exec on macOS. It is missing on this system, so the command did not run. Turn the sandbox off in /permissions.",
		};
	}
	const profile = seatbeltProfile(state, cwd);
	const inner = `${shellQuote(tools.shell)} -lc ${shellQuote(command)}`;
	return {
		command: `${shellQuote(tools.sandboxExec)} -p ${shellQuote(profile)} ${inner}`,
	};
}

function linuxPlan(command: string, state: PermissionsState, tools: SandboxTools, cwd: string): SandboxPlan {
 let inner = `${shellQuote(tools.shell)} -lc ${shellQuote(command)}`;
 if (tools.bwrap !== null) {
  if (state.sandboxes.filesystem === "off") {
   const net = state.sandboxes.no_network ? " --unshare-net" : "";
   return {command: `${shellQuote(tools.bwrap)} --bind / / --dev /dev --proc /proc${net} --die-with-parent -- ${inner}`};
  }
  // A protected root is placed when the sandbox can reproduce it. A project link to a
  // system binary is ordinary. A plan that cannot show the working directory fails closed.
  const classified = classifyRoots(sandboxRoots(state, cwd));
  const roots = classified.roots;
  const workdir = realpathSync(cwd);
  const system = systemMounts();
  const readText = (path: string) => {try {return readFileSync(path,"utf8");} catch {return null;}};
  const git = classifyRoots(gitDirectories(workdir,readText));
  const reproduced = [...new Set([...classified.reproduced, ...git.reproduced])].sort();
  const visible = [...roots, ...reproduced];
  const workdirVisible = system.binds.some(bind => containsPath(bind.source, workdir)) || visible.some(root => containsPath(root, workdir));
  if (!workdirVisible) {
   return {error: `The filesystem sandbox cannot expose the working directory ${workdir}. Its allowed roots all overlap a system or private tree, so the command did not run. Turn the sandbox off in /permissions, or move the project out of that tree.`};
  }
  const writableBind = state.sandboxes.filesystem === "read" ? "--ro-bind" : "--bind";
  const args = ["--tmpfs", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/etc"];
  for (const bind of system.binds) args.push("--ro-bind", bind.source, bind.target);
  for (const link of system.symlinks) args.push("--symlink", link.target, link.path);
  // The `/etc` entries come first, and the reproduced binds after them, so a writable
  // reproduced mount wins over the read-only default entry for the same path.
  for (const entry of etcMounts()) args.push("--ro-bind", entry.source, entry.target);
  for (const path of [...new Set([...roots, ...git.roots])].sort()) args.push(writableBind, path, path);
  for (const path of reproduced) {
   const fromGit = git.reproduced.includes(path);
   args.push(fromGit ? writableBind : "--ro-bind", path, path);
  }
  const shell = realpathSync(tools.shell);
  if (!system.binds.some(b=>containsPath(b.source,shell))) args.push("--ro-bind", dirname(shell),dirname(shell));
  args.push("--dir", "/run/pi-home", "--setenv", "HOME", "/run/pi-home", "--chdir", workdir, "--die-with-parent");
  if (state.sandboxes.no_network) args.push("--unshare-net");
  const accounts = accountFiles(process.getuid?.() ?? 1000,process.getgid?.() ?? 1000).map(f=>`printf %s ${shellQuote(f.content)} > /etc/${f.name}`).join("; ");
  inner = `${shellQuote(tools.shell)} -c ${shellQuote(`${accounts}; exec ${inner}`)}`;
  return {command: `${shellQuote(tools.bwrap)} ${args.map(shellQuote).join(" ")} -- ${inner}`};
 }
 if (state.sandboxes.filesystem !== "off") return {error:"The filesystem sandbox needs bubblewrap (bwrap). Install bubblewrap, or turn the sandbox off in /permissions."};
 if (tools.unshare !== null) return {command: `${shellQuote(tools.unshare)} -n -- ${inner}`};
 return {error:"The no-network sandbox needs bubblewrap (bwrap) or unshare. Install one, or turn the sandbox off in /permissions."};
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
 cwd = process.cwd(),
): SandboxPlan {
	if (state.sandboxes.filesystem === "off" && !state.sandboxes.no_network) return null;

	if (tools.platform === "win32") {
		return {
			error:
				"Native Windows has no sandbox backend in this extension, so the command did not run. Run pi inside WSL2 to use bubblewrap, or turn the sandbox off in /permissions.",
		};
	}
	try {
  if (tools.platform === "darwin") return macOSPlan(command, state, tools, cwd);
  if (tools.platform === "linux") return linuxPlan(command, state, tools, cwd);
 } catch (error) {
  return {error: `The filesystem sandbox did not start: ${error instanceof Error ? error.message : String(error)}`};
 }

	return {
		error: `The sandboxes are not available on ${tools.platform}, so the command did not run. Turn the sandbox off in /permissions.`,
	};
}
