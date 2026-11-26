import { accessSync, constants, existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FilesystemMode } from "./types.ts";
import { extensionRoot, isBuiltinExtensionSource } from "./forwarding.ts";
import { fileURLToPath } from "node:url";
import { SYSTEM_TREES, classifyPlacement, containsPath, reservedForSandbox } from "./paths.ts";

export interface IsolatedLaunchOptions {
	socketPath: string;
	token: string;
	cwd: string;
	extensions: string[];
	filesystem: FilesystemMode;
	paths: string[];
	/**
	 * Extra host directories that the sandbox mounts at the same path. A read-write entry
	 * is bound writable. Each must be an absolute path that the caller validated.
	 */
	mounts?: ReadonlyArray<{ path: string; writable: boolean }>;
	/** True isolates the network namespace. False keeps the host network. The caller always passes it. */
	network: boolean;
	piPath?: string;
	nodePath?: string;
	/**
	 * The host Pi agent directory, usually `~/.pi/agent`. Its rules, agents, extensions,
	 * skills, prompts, themes, and packages become visible read-only. Undefined mounts none.
	 */
	piAgentDir?: string;
	/**
	 * The pi-subagents run directory. It is mounted writable and named in the sandbox
	 * environment, so a run launched inside the sandbox is the run that the host lists.
	 */
	subagentsRoot?: string;
	/** Stable, opaque identity for the in-memory sandbox session. No host session file. */
	sessionId?: string;
	/** Overrides for tests. The defaults mount the entries that ordinary programs read. */
	etcFiles?: readonly string[];
	etcDirectories?: readonly string[];
	agentFiles?: readonly string[];
	agentDirectories?: readonly string[];
}

export interface IsolatedLaunchDependencies {
	platform: NodeJS.Platform;
	env: Readonly<Record<string, string | undefined>>;
	/** Return an absolute executable path, or null. No subprocess probes. */
	findExecutable: (name: string, path: string) => string | null;
	/** Canonical absolute path. Injected so the tests do not need the host layout. */
	realPath?: (path: string) => string;
	/** Symlink target, or null when the path is not a link. */
	readLink?: (path: string) => string | null;
	/** Whether a path exists on the host. */
	exists?: (path: string) => boolean;
	/** Read a small text file, or null. */
	readText?: (path: string) => string | null;
}

/**
 * Git directories that a worktree or submodule keeps outside its working directory.
 * A pointer file names one directory, and a `commondir` file can name the shared parent.
 *
 * The pointer is repository content, so a crafted `.git` file could name any host path.
 * A directory is reported only when it looks like a git directory, which a secret file
 * or a home directory does not. The caller mounts it read-only or writable, so the check
 * must not trust the file name alone.
 */
export function gitDirectories(
	workdir: string,
	readText: (path: string) => string | null,
	exists: (path: string) => boolean = existsSync,
): string[] {
	const pointer = readText(join(workdir, ".git"));
	if (pointer === null) return [];
	const match = /^gitdir:\s*(.+)$/m.exec(pointer);
	if (!match) return [];
	const gitDir = resolve(workdir, match[1].trim());
	if (gitDir === workdir || gitDir.startsWith(`${workdir}/`)) return [];
	// A real git directory holds HEAD and either objects or a commondir pointer.
	const looksLikeGit = exists(join(gitDir, "HEAD")) && (exists(join(gitDir, "objects")) || exists(join(gitDir, "commondir")));
	if (!looksLikeGit) return [];
	const found = [gitDir];
	const common = readText(join(gitDir, "commondir"));
	if (common !== null) {
		const shared = resolve(gitDir, common.trim());
		if (isAbsolute(shared) && !shared.startsWith(`${workdir}/`) && exists(join(shared, "objects"))) found.push(shared);
	}
	return found;
}

/** A fixed host name inside the sandbox. It must not identify the host machine. */
export const HOST_NAME = "sandbox";

/** The PATH inside the sandbox. The relay links the programs into `/run/pi-bin`. */
export const BIN_PATH = "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin";

function findExecutable(name: string, path: string): string | null {
	const candidates = isAbsolute(name) ? [name] : path.split(":").filter(isAbsolute).map((dir) => join(dir, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

function pathExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function absolutePath(value: string, label: string): void {
	if (!value || !isAbsolute(value) || value.includes("\0")) {
		throw new Error(`${label} must be an absolute path without null bytes.`);
	}
}

/** Every directory above `path`, from the top down, excluding `/` and the path itself. */
export function parentDirectories(path: string): string[] {
	const parts = resolve(path).split("/").filter(Boolean);
	const found: string[] = [];
	for (let index = 1; index < parts.length; index += 1) found.push(`/${parts.slice(0, index).join("/")}`);
	return found;
}

export { containsPath } from "./paths.ts";

/** The number of path components, so that a parent sorts before its children. */
function depth(path: string): number {
	return resolve(path).split("/").filter(Boolean).length;
}

/** The path components strictly between `root` and `path`, which `root` contains. */
function componentsBetween(root: string, path: string): string[] {
	return path.slice(root.length + 1).split("/").filter(Boolean);
}

/**
 * True when the sandbox shows a symlink between a mounted directory and a nested path.
 *
 * A bound directory keeps the host tree unchanged, symlinks included, so the nested path
 * is a symlink inside the sandbox too. bwrap refuses a bind on a symlink destination, and
 * the mount would fail even though the host path looks ordinary.
 */
export function crossesLink(
	root: string,
	path: string,
	link: (path: string) => string | null = (value) => {
		try {
			return readlinkSync(value);
		} catch {
			return null;
		}
	},
): boolean {
	if (!containsPath(root, path) || root === path) return false;
	let current = root;
	for (const component of componentsBetween(root, path)) {
		current = `${current}/${component}`;
		if (link(current) !== null) return true;
	}
	return false;
}

/**
 * The binds that bwrap can apply, in an order where every parent comes first.
 *
 * A nested mount passes through a directory that another mount already binds. When the
 * host path between them is a symlink, the bind cannot land on that link. The link itself
 * already names the file, so the nested bind becomes a bind of its resolved target, and it
 * disappears when a kept mount makes that target visible already.
 *
 * Nothing here drops a path that stays invisible: a mount with no link in between, or one
 * whose target no other mount covers, keeps its own bind.
 */
export function bindableMounts(
	mounts: ReadonlyMap<string, { writable: boolean }>,
	link: (path: string) => string | null = (value) => {
		try {
			return readlinkSync(value);
		} catch {
			return null;
		}
	},
	canonical: (path: string) => string = realpathSync,
): Array<{ path: string; writable: boolean }> {
	const kept: Array<{ path: string; writable: boolean }> = [];
	const ordered = [...mounts.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
	for (const path of ordered) {
		const writable = mounts.get(path)!.writable === true;
		const shadowed = kept.some((entry) => crossesLink(entry.path, path, link));
		if (!shadowed) {
			kept.push({ path, writable });
			continue;
		}
		// A symlink already shows the file through the parent mount. Bind the target that
		// the link names, unless a kept mount already makes it visible.
		let target: string;
		try {
			target = canonical(path);
		} catch {
			continue;
		}
		if (target === path || kept.some((entry) => containsPath(entry.path, target))) continue;
		if (kept.some((entry) => crossesLink(entry.path, target, link))) continue;
		// A link inside a home or agent entry must not pull a system tree into view.
		if (reservedForSandbox(target) && !reservedForSandbox(path)) continue;
		kept.push({ path: target, writable });
	}
	return kept;
}

/** True when the system binds that the sandbox makes on its own already show this path. */
export function insideSystemTree(path: string): boolean {
	return SYSTEM_TREES.some((tree) => containsPath(tree, path));
}

export interface ClassifiedRoots {
	/** Canonical roots that the sandbox can bind at their own path. */
	roots: string[];
	/** Protected roots that the sandbox puts back in view with a read-only bind. */
	reproduced: string[];
	/** Protected roots that no mount will cover, so the sandbox cannot reach them. */
	unreachable: string[];
	/** Protected roots that the system binds already show read-only, so skipping one loses nothing. */
	covered: string[];
}

/**
 * Splits the requested roots into the ones a sandbox can bind and the ones it cannot.
 *
 * A protected root arrives from ordinary work: a `.venv` binary links to `/usr/bin/python3.13`,
 * and a package manager links a shim into `/usr`. Most protected roots can still be placed.
 * A root below a system tree is already visible read-only. A root inside a tree that the
 * sandbox mounts empty, such as `/etc` or `/run`, goes back in view with a read-only bind at
 * its own path. Only a root that would replace a private mount, or that names a pseudo
 * filesystem, is left out. The launch continues in every case, because a fatal error stops
 * every tool in the session. Only a path that is not absolute fails here, because that is a
 * caller defect, not host content.
 */
export function classifyRoots(paths: string[], canonical: (path: string) => string = realpathSync): ClassifiedRoots {
	const roots: string[] = [];
	const reproduced: string[] = [];
	const unreachable: string[] = [];
	const covered: string[] = [];
	for (const path of paths) {
		absolutePath(path, "Allowed root");
		const root = canonical(resolve(path));
		const keep = (list: string[]): void => { if (!list.includes(root)) list.push(root); };
		switch (classifyPlacement(root)) {
			case "covered":
				keep(covered);
				break;
			case "reproducible":
				keep(reproduced);
				break;
			case "refused":
				keep(unreachable);
				break;
			default:
				keep(roots);
		}
	}
	return { roots, reproduced, unreachable, covered };
}

export interface SystemMounts {
	binds: Array<{ source: string; target: string }>;
	symlinks: Array<{ target: string; path: string }>;
}

/**
 * The system directories that Node and Pi need. A directory that resolves below `/usr`
 * becomes a symlink, so a merged `/usr` is not mounted twice.
 */
export function systemMounts(
	exists: (path: string) => boolean = pathExists,
	link: (path: string) => string | null = (path) => {
		try {
			return readlinkSync(path);
		} catch {
			return null;
		}
	},
): SystemMounts {
	const binds: SystemMounts["binds"] = [];
	const symlinks: SystemMounts["symlinks"] = [];
	for (const name of ["bin", "sbin", "lib", "lib64"]) {
		const path = `/${name}`;
		if (!exists(path)) continue;
		const target = link(path);
		if (target !== null) {
			const absolute = resolve("/", target);
			if (absolute === `/usr/${name}` || absolute.startsWith(`/usr/${name}/`)) {
				symlinks.push({ target: `usr/${name}`, path });
				continue;
			}
		}
		binds.push({ source: path, target: path });
	}
	const ordered = [...binds];
	if (exists("/usr")) ordered.unshift({ source: "/usr", target: "/usr" });
	return { binds: ordered, symlinks };
}

/** The `/etc` entries that programs read. The whole directory would expose host accounts,
 * host keys, and host configuration that no program here needs. */
export const ETC_FILES = [
	"nsswitch.conf",
	"hosts",
	"hostname",
	"resolv.conf",
	"localtime",
	"ld.so.cache",
	"ld.so.conf",
	"gitconfig",
	"profile",
	"bash.bashrc",
	"environment",
	"inputrc",
	"services",
	"protocols",
 "ssl/openssl.cnf",
];

/** `/etc` directories with data that the binaries read at runtime. */
export const ETC_DIRECTORIES = ["ssl/certs", "ca-certificates", "ld.so.conf.d", "terminfo", "alternatives"];

/** Entries that the launcher generates inside the sandbox instead of taking them from the host. */
export const GENERATED_ETC = ["passwd", "group"] as const;

export function etcMounts(
	exists: (path: string) => boolean = pathExists,
	files: readonly string[] = ETC_FILES,
	directories: readonly string[] = ETC_DIRECTORIES,
): Array<{ source: string; target: string }> {
	const found: Array<{ source: string; target: string }> = [];
	for (const name of files) {
		const path = `/etc/${name}`;
		if (exists(path)) found.push({ source: path, target: path });
	}
	for (const name of directories) {
		const path = `/etc/${name}`;
		if (exists(path)) found.push({ source: path, target: path });
	}
	return found;
}

/**
 * Files under the Pi agent directory that a sandboxed extension reads.
 * `auth.json` holds credentials, so it stays outside. So do sessions and caches.
 */
export const AGENT_DIR_FILES = [
	"settings.json",
	"keybindings.json",
	"mcp.json",
	"subagents.json",
	"model-alias.json",
	"APPEND_SYSTEM.md",
	"SYSTEM.md",
	"AGENTS.md",
	"AGENTS.override.md",
];

/** Directories under the Pi agent directory that a tool or an extension reads. */
export const AGENT_DIR_DIRECTORIES = ["rules", "agents", "extensions", "skills", "prompts", "themes", "npm"];

/** Where the agent directory appears inside the sandbox, so a program that uses `homedir()` finds it. */
export const HOME_AGENT_DIR = "/run/pi-home/.pi/agent";

/**
 * Files directly under the host home directory that a sandboxed program reads.
 * `~/.gitconfig` gives git the identity that it needs for a commit, and `~/.profile`
 * carries the shell setup. Both are read-only. Credentials live elsewhere.
 */
export const HOME_FILES = [".gitconfig", ".profile"];

/**
 * The directories on the host PATH, which a sandboxed command must also reach.
 * A program that the outer shell finds by name has to resolve to the same file.
 */
export function pathDirectories(pathValue: string | undefined): string[] {
	return [...new Set((pathValue ?? "").split(":").filter((dir) => dir.length > 0 && isAbsolute(dir)))];
}

/** The extra home entries that exist on the host. A missing entry is skipped. */
export function homeMounts(
	home: string,
	exists: (path: string) => boolean = pathExists,
	files: readonly string[] = HOME_FILES,
): Array<{ source: string; target: string }> {
	const found: Array<{ source: string; target: string }> = [];
	for (const name of files) {
		const path = join(home, name);
		if (exists(path)) found.push({ source: path, target: path });
	}
	return found;
}

/** Where the extra home entries appear inside the sandbox, below the private home. */
export const HOME_MIRROR = "/run/pi-home";

/** A writable temp directory for the inner tools. A read-only scope can bind `/tmp`. */
export const SANDBOX_TEMP_DIR = "/run/pi-home/tmp";

/** The agent-directory entries that exist on the host. A missing entry is skipped. */
export function agentDirectoryMounts(
	agentDir: string,
	exists: (path: string) => boolean = pathExists,
	files: readonly string[] = AGENT_DIR_FILES,
	directories: readonly string[] = AGENT_DIR_DIRECTORIES,
): Array<{ source: string; target: string }> {
	const found: Array<{ source: string; target: string }> = [];
	for (const name of [...files, ...directories]) {
		const path = join(agentDir, name);
		if (exists(path)) found.push({ source: path, target: path });
	}
	return found;
}

/** A minimal account database. The host users and their home paths stay outside the sandbox. */
export function accountFiles(uid: number, gid: number): Array<{ name: string; content: string }> {
	return [
		{ name: "passwd", content: `pi:x:${uid}:${gid}:Sandboxed user:/tmp/home:/bin/sh\n` },
		{ name: "group", content: `pi:x:${gid}:\n` },
	];
}

export interface IsolatedLaunchPlan {
	command: string;
	args: string[];
	env: Record<string, string>;
	/**
	 * Host paths that the sandbox cannot show. A path that would replace a private mount,
	 * or that names a pseudo filesystem, is left out. The rest of the launch still starts,
	 * so one such path never removes every tool from the session.
	 */
	skipped: string[];
	/**
	 * Host paths that stay reachable without a bind, because the system mounts already show
	 * them read-only. No access is lost, so the caller reports no warning for these.
	 */
	covered: string[];
}

/**
 * Build argv without starting a process or creating files.
 *
 * The sandbox starts with an empty root. Only these paths become visible: the system
 * directories, read-only; the executables and the relay, read-only; the working directory
 * and the extensions, read-only or writable by the layer; one control socket; and empty
 * `/tmp`, `/run`, `/dev`, and `/proc`. Home files, credentials, other projects, and host
 * sockets outside those mounts stay out of view.
 *
 * The caller owns the authenticated HTTP server on a private host Unix socket, and the
 * relay creates the agent directory inside the sandbox. With network isolation, bwrap adds
 * `--unshare-net` and initializes loopback, and the relay listens on that loopback alone.
 * Without it, the relay uses the host loopback and the argv omits the flag.
 *
 * A bwrap runtime failure must stop launch. The caller must never retry without the sandbox.
 * `PI_TOOLSET_INNER=1` lets the outer extension skip a recursive bridge start.
 */
export function buildIsolatedLaunch(
	options: IsolatedLaunchOptions,
	dependencies: IsolatedLaunchDependencies = { platform: process.platform, env: process.env, findExecutable },
): IsolatedLaunchPlan {
	if (dependencies.platform !== "linux") throw new Error("The isolated launcher requires Linux.");
	const canonical = dependencies.realPath ?? ((path: string) => realpathSync(path));
	const exists = dependencies.exists ?? pathExists;
	const readText = dependencies.readText ?? ((path: string) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	});
	absolutePath(options.socketPath, "socketPath");
	absolutePath(options.cwd, "cwd");
	if (!options.token || /[\x00-\x20\x7f]/.test(options.token)) {
		throw new Error("The bridge token must be nonempty and contain no whitespace or control bytes.");
	}
	if (options.sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.sessionId)) {
		throw new Error("sessionId must be a valid Pi session ID.");
	}
	if (typeof options.network !== "boolean") throw new Error("network must be a boolean.");
	if (!["off", "read", "read+write"].includes(options.filesystem)) throw new Error("Invalid filesystem mode.");
	if (!Array.isArray(options.paths)) throw new Error("paths must be an array.");
	const restricted = options.filesystem !== "off";
	const modelRelayPath = fileURLToPath(new URL("./inner-model.ts", import.meta.url));

	// Resolved with the host PATH, then replaced by the directories that the sandbox mounts.
	const hostPath = dependencies.env.PATH ?? "/usr/bin:/bin";
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		HOME: "/run/pi-home",
		LANG: dependencies.env.LANG ?? "C.UTF-8",
		TERM: dependencies.env.TERM ?? "dumb",
		PI_TOOLSET_INNER: "1",
		PI_BRIDGE_SOCKET: "/run/pi-bridge/model.sock",
		PI_BRIDGE_TOKEN: options.token,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		PI_CODING_AGENT_DIR: "/run/pi-agent-private",
		// The relay writes the extension into the private settings so that the root and
		// every child session load it exactly once through normal resource discovery.
		PI_BRIDGE_MODEL_EXTENSION: modelRelayPath,
		// A fixed host name. The default would show the name of the host machine.
		HOSTNAME: HOST_NAME,
	};
	// The temp directory lives below `/run`. A read-only scope path for `/tmp` would otherwise
	// make every temp file fail, including the state that an extension writes at load.
	if (restricted) env.TMPDIR = SANDBOX_TEMP_DIR;

	const executable = (name: string): string => {
		const found = dependencies.findExecutable(name, hostPath);
		if (!found) throw new Error(`Required executable is unavailable: ${name}`);
		absolutePath(found, "Executable");
		return canonical(found);
	};
	if (options.piPath !== undefined) absolutePath(options.piPath, "piPath");
	if (options.nodePath !== undefined) absolutePath(options.nodePath, "nodePath");
	const command = executable("bwrap");
	const pi = executable(options.piPath ?? "pi");
	const node = executable(options.nodePath ?? "node");
	const relay = canonical(fileURLToPath(new URL("./inner-relay.mjs", import.meta.url)));
	const modelRelay = canonical(modelRelayPath);
	// The relay is mounted as one file, so every module that it imports needs its own mount.
	// A sibling module that resolves inside the package would otherwise be missing whenever
	// only the relay file is placed.
	const modelRelaySupport = canonical(fileURLToPath(new URL("./relay-identity.ts", import.meta.url)));
	const inventory = canonical(fileURLToPath(new URL("./inner-inventory.ts", import.meta.url)));
	const workdir = canonical(resolve(options.cwd));
	const extensions = options.extensions.map((path) => {
		if (isBuiltinExtensionSource(path)) return path;
		if (!path || path.includes("\0") || path.startsWith("builtin:")) {
			throw new Error("Extensions must be explicit filesystem paths.");
		}
		return canonical(resolve(options.cwd, path));
	});

	// PATH names only directories that exist inside the sandbox. The relay links the two
	// programs into /run/pi-bin, so no host directory appears in the environment.
	env.PATH = BIN_PATH;

	// A bind keeps the host path, so a path inside Pi and inside the tool agree.
	const writable = new Map<string, boolean>();
	const addMount = (path: string, writableHere: boolean): void => {
		const previous = writable.get(path);
		writable.set(path, previous === true || writableHere);
	};
	// A scope path that an allowed root cannot take is still placed when the sandbox can
	// reproduce it. A virtual environment links its interpreter to `/usr/bin/python3.13`,
	// and a package manager links a shim into `/usr`, so the paths arrive without a user
	// action. The roots that cannot be placed are reported and the launch continues.
	const classified = restricted ? classifyRoots(options.paths, canonical) : { roots: [], reproduced: [], unreachable: [], covered: [] };
	const roots = classified.roots;
	// A working directory inside a system tree is already visible read-only, because the
	// sandbox binds that tree itself. It is reported, not fatal, so a project below `/usr`
	// keeps the sandboxed tools available.
	const workdirInSystemTree = restricted && insideSystemTree(workdir);
	// A reproduced root counts too: the bind puts the working directory in view, so the
	// command finds its own files.
	const workdirPlaced = roots.some(root => containsPath(root, workdir))
		|| (restricted && classified.reproduced.some(root => containsPath(root, workdir)));
 if (restricted && !workdirInSystemTree && !workdirPlaced) throw new Error("cwd must belong to an allowed root.");
 for (const root of roots) addMount(root, options.filesystem === "read+write");
	// A protected root that the scope produced goes back in view with a read-only bind at its
	// own path. `/etc` and `/run` start empty, so the bind restores the part of the tree that
	// the work needs, and the sandbox keeps owning the rest. The bind is written after the
	// private mounts and before the scope roots, so neither a tmpfs nor a root hides it.
	const reproduced = new Map<string, boolean>();
	for (const path of restricted ? classified.reproduced : []) reproduced.set(path, false);
	// A worktree keeps its git directories outside the project. Git needs them to work, and
	// with the read-only layer off, git must also be able to write its index and objects.
	// A pointer file is repository content, so a path that cannot be placed is left out.
	const gitClassification = restricted ? classifyRoots(gitDirectories(workdir, readText, exists), canonical) : { roots: [], reproduced: [], unreachable: [], covered: [] };
	for (const path of gitClassification.roots) addMount(path, options.filesystem === "read+write");
	for (const path of gitClassification.reproduced) if (!reproduced.has(path)) reproduced.set(path, options.filesystem === "read+write");
	for (const path of extensions.filter(path => !isBuiltinExtensionSource(path))) addMount(extensionRoot(path, exists), false);
	// The programs and their bin directories. A shell inside the sandbox must find them in
	// PATH, for example when a tool starts `node` itself.
	for (const path of [node, dirname(node), pi, dirname(pi), relay, inventory, modelRelay, modelRelaySupport]) addMount(path, false);
	// A run launched inside the sandbox must land in the host's own run directory, or the
	// host fleet cannot list, steer, or clean it up. The path is a data directory that the
	// inner Pi owns, so it stays writable even when the filesystem layer is read-only.
	if (options.subagentsRoot !== undefined) {
		const shared = canonical(resolve(options.subagentsRoot));
		addMount(shared, true);
		env.PI_SUBAGENTS_TEMP_ROOT = shared;
	}
	// `/etc` is mounted entry by entry. The account databases are generated instead of copied,
	// so host user names and home paths do not enter the sandbox.
	for (const entry of etcMounts(exists, options.etcFiles ?? ETC_FILES, options.etcDirectories ?? ETC_DIRECTORIES)) {
		addMount(entry.source, false);
	}
	// Custom mounts. The user named these directories, so the sandbox sees them at the same
	// path. A path that the scope roots already cover, or that the sandbox owns, is skipped.
	const refusedMounts: string[] = [];
	for (const entry of restricted ? (options.mounts ?? []) : []) {
		absolutePath(entry.path, "Mount");
		const path = canonical(resolve(entry.path));
		const placement = classifyPlacement(path);
		if (placement === "refused") {
			refusedMounts.push(path);
			continue;
		}
		if (roots.some((root) => containsPath(root, path))) continue;
		// The user named this path, so a reproducible tree becomes visible read-only. A
		// writable request still reaches the host, as it does for any other mount.
		if (placement === "reproducible") {
			reproduced.set(path, entry.writable === true);
			continue;
		}
		if (placement === "covered") continue;
		addMount(path, entry.writable === true);
	}
	// The Pi configuration. Extensions read rules, agent definitions, and their own packages
	// from it. The entries are mounted one by one, so credentials, sessions, and caches stay out.
	const agentDir = options.piAgentDir === undefined ? undefined : canonical(resolve(options.piAgentDir));
	const agentEntries = agentDir !== undefined ? agentDirectoryMounts(agentDir, exists, options.agentFiles ?? AGENT_DIR_FILES, options.agentDirectories ?? AGENT_DIR_DIRECTORIES) : [];
	for (const entry of restricted ? agentEntries : []) addMount(entry.source, false);
	// An extension that reads the configuration from the home directory looks below `HOME`.
	// The same entries appear there too, at the path that the default layout uses.
	const mirrored: Array<{ source: string; target: string }> = restricted
		? agentEntries.map((entry) => ({ source: entry.source, target: join(HOME_AGENT_DIR, entry.source.slice(agentDir!.length + 1)) }))
		: [];
	// The inner Pi asks `getAgentDir()` for the configuration. The relay links the mounted
	// entries into its private directory, so a tool finds them without a host write.
	if (restricted && agentDir !== undefined && agentEntries.length > 0) {
		env.PI_BRIDGE_HOST_AGENT_DIR = agentDir;
		env.PI_BRIDGE_AGENT_ENTRIES = agentEntries.map((entry) => entry.source.slice(agentDir.length + 1)).join(",");
	}
	// The host home directory contributes a few named entries, never the tree. Each is
	// read-only and appears at its host path and below the private home.
	const homeEntries = restricted && dependencies.env.HOME ? homeMounts(canonical(resolve(dependencies.env.HOME)), exists) : [];
	for (const entry of homeEntries) addMount(entry.source, false);
	const homeMirrored: Array<{ source: string; target: string }> = homeEntries.map((entry) => ({
		source: entry.source, target: join(HOME_MIRROR, entry.source.slice(canonical(resolve(dependencies.env.HOME!)).length + 1)),
	}));
	// Every directory on the host PATH. A program that the outer shell finds by name must
	// resolve to the same file inside, so the directories are mounted read-only at their
	// own paths, and the ones that exist join PATH. A path that a writable root already
	// covers is left to that root, and a system directory is already mounted.
	const hostDirectories = pathDirectories(dependencies.env.PATH);
	const sandboxDirectories = restricted
		? hostDirectories.filter((dir) => exists(dir) && !reservedForSandbox(dir) && !roots.some((root) => root !== dir && containsPath(root, dir)))
		: [];
	for (const dir of sandboxDirectories) addMount(dir, false);
	if (sandboxDirectories.length > 0) env.PATH = `${env.PATH}:${sandboxDirectories.join(":")}`;

	// Optional Hypa runtime. Keep both the canonical binary and the alias used by host rewrites.
	const hypaAlias = dependencies.findExecutable("hypa", hostPath);
	if (hypaAlias) {
		const hypa = canonical(hypaAlias);
		addMount(hypa, false);
		if (hypaAlias !== hypa) addMount(hypaAlias, false);
		env.PI_BRIDGE_HYPA = hypa;
	}
	// A redundant runtime bind must not mask a writable project subtree.
	for (const path of writable.keys()) {
		if (roots.some(root => root !== path && containsPath(root, path))) writable.delete(path);
	}
	const mounts = new Map<string, { source: string; writable: boolean }>();
	for (const path of writable.keys()) mounts.set(path, { source: path, writable: writable.get(path) === true });
	const system = systemMounts(exists, dependencies.readLink);
	const reserved = new Set(["/run", "/dev", "/proc", ...system.binds.map((bind) => bind.target)]);
	// A mount that lands on a private mount point cannot be placed, so it is dropped. A file
	// below a system tree binds nothing new, because the tree is already visible read-only.
	const dropped: string[] = [];
	for (const path of [...mounts.keys()]) {
		if (!restricted || !reserved.has(path)) continue;
		mounts.delete(path);
		dropped.push(path);
	}
	// A protected scope root binds nothing, and a protected git pointer binds nothing either.
	// A root below a system tree adds no mount, because that tree is already read-only.
	const skipped = restricted
		? [...new Set([
			...classified.unreachable, ...gitClassification.unreachable, ...dropped, ...refusedMounts,
			// The system binds show this path read-only, so a write there fails. Say so.
			...(workdirInSystemTree ? [workdir] : []),
		])].sort()
		: [];
	// A covered path loses no access, so it is not a skip. The list is still reported, so a
	// caller can say why the path needs no mount of its own.
	const covered = restricted
		? [...new Set([...classified.covered, ...gitClassification.covered])].sort()
		: [];

	const args: string[] = [
		...(options.network ? ["--unshare-net"] : []),
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		// The IPC namespace hides shared memory and semaphores; the UTS namespace hides the host name.
		"--unshare-ipc",
		"--unshare-uts",
		// A fixed name. The default would show the name of the host machine.
		"--hostname",
		HOST_NAME,
		// An empty root. Nothing from the host is visible unless it is added below.
		// `--dev-bind` keeps device nodes usable. A plain `--bind` of the root leaves some
		// entries in a state where spawning an executable returns EACCES.
		...(restricted ? ["--tmpfs", "/"] : ["--dev-bind", "/", "/"]),
	];
	for (const bind of restricted ? system.binds : []) args.push("--ro-bind", bind.source, bind.target);
	for (const link of restricted ? system.symlinks : []) args.push("--symlink", link.target, link.path);
	// An empty `/etc`. The selected entries are bound below, and the relay writes the
	// generated account files before it starts Pi.
	args.push("--proc", "/proc");
 if (restricted) args.push("--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--dir", "/tmp/home");
 args.push("--tmpfs", "/run", "--dir", "/run/pi-home");
 env.PI_BRIDGE_GENERATE_ACCOUNTS = restricted ? "1" : "0";
	// `/proc/sys/kernel/random/boot_id` identifies the host boot. Node and OpenSSL read
	// `/dev/urandom` for entropy, so an empty directory here changes nothing else.
	if (restricted) args.push("--tmpfs", "/proc/sys/kernel/random");

	// A mount point must exist inside the sandbox before a bind targets it.
	const created = new Set([...reserved, "/tmp/home"]);
	// A bind below another mount cannot land on a host symlink, which the parent mount
	// shows unchanged. `bindableMounts` resolves that case before the args are written.
	const binds = restricted ? bindableMounts(mounts, dependencies.readLink, canonical) : [];
	// A resolved bind can name a path outside the mount list, so its parents need a mount point too.
	const targets = [...new Set([
		...binds.map((entry) => entry.path),
		...mirrored.map((entry) => entry.target),
		...homeMirrored.map((entry) => entry.target),
		// A reproduced subtree needs its parents, such as `/etc/docker` needing `/etc`.
		...reproduced.keys(),
	])].sort();
	for (const path of targets) {
		for (const dir of parentDirectories(path)) {
			if (created.has(dir)) continue;
			created.add(dir);
			args.push("--dir", dir);
		}
	}
	for (const entry of binds) args.push(entry.writable ? "--bind" : "--ro-bind", entry.path, entry.path);
	for (const entry of mirrored) args.push("--ro-bind", entry.source, entry.target);
	for (const entry of homeMirrored) args.push("--ro-bind", entry.source, entry.target);
	// A reproduced path goes back in view at its own path, after every private mount and
	// after the default `/etc` entries. A read-only bind keeps the sandbox in charge. A
	// writable bind is the request of the user who named the path, and it wins over a
	// read-only entry for the same path.
	for (const [path, writableHere] of [...reproduced.entries()].sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b))) {
		args.push(writableHere ? "--bind" : "--ro-bind", path, path);
	}

	args.push(
		"--dir", "/run/pi-bridge",
		"--ro-bind", options.socketPath, env.PI_BRIDGE_SOCKET,
		"--dir", "/run/pi-agent",
  "--dir", "/run/pi-agent-private",
		"--chdir", workdir,
		"--", node,
		relay, pi,
		"--mode", "rpc",
		"--no-session",
		...(options.sessionId ? ["--session-id", options.sessionId] : []),
		"--provider", "bridge",
		"--model", "bridge",
		"--thinking", "off",
		"--tools", "*",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-mcp",
		"--no-approve",
		"--offline",
		...extensions.flatMap((path) => ["--extension", path]),
		"--extension", inventory,
		"--extension", modelRelay,
	);
	return { command, args, env, skipped, covered };
}
