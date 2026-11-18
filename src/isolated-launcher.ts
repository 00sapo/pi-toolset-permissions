import { accessSync, constants, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface IsolatedLaunchOptions {
	socketPath: string;
	token: string;
	cwd: string;
	extensions: string[];
	readonly: boolean;
	/** True isolates the network namespace. False keeps the host network. The caller always passes it. */
	network: boolean;
	piPath?: string;
	nodePath?: string;
	/** Overrides for tests. The defaults mount the entries that ordinary programs read. */
	etcFiles?: readonly string[];
	etcDirectories?: readonly string[];
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
 * Both are returned so git can read its objects and references.
 */
export function gitDirectories(workdir: string, readText: (path: string) => string | null): string[] {
	const pointer = readText(join(workdir, ".git"));
	if (pointer === null) return [];
	const match = /^gitdir:\s*(.+)$/m.exec(pointer);
	if (!match) return [];
	const gitDir = resolve(workdir, match[1].trim());
	if (gitDir === workdir || gitDir.startsWith(`${workdir}/`)) return [];
	const found = [gitDir];
	const common = readText(join(gitDir, "commondir"));
	if (common !== null) {
		const shared = resolve(gitDir, common.trim());
		if (isAbsolute(shared) && !shared.startsWith(`${workdir}/`)) found.push(shared);
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
];

/** `/etc` directories with data that the binaries read at runtime. */
export const ETC_DIRECTORIES = ["ssl", "ca-certificates", "ld.so.conf.d", "terminfo", "alternatives"];

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

/** A minimal account database. The host users and their home paths stay outside the sandbox. */
export function accountFiles(uid: number, gid: number): Array<{ name: string; content: string }> {
	return [
		{ name: "passwd", content: `pi:x:${uid}:${gid}:Sandboxed user:/tmp/home:/bin/sh\n` },
		{ name: "group", content: `pi:x:${gid}:\n` },
	];
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
): { command: string; args: string[]; env: Record<string, string> } {
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
	if (typeof options.network !== "boolean") throw new Error("network must be a boolean.");
	if (typeof options.readonly !== "boolean") throw new Error("readonly must be a boolean.");

	// Resolved with the host PATH, then replaced by the directories that the sandbox mounts.
	const hostPath = dependencies.env.PATH ?? "/usr/bin:/bin";
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		HOME: "/tmp/home",
		LANG: dependencies.env.LANG ?? "C.UTF-8",
		TERM: dependencies.env.TERM ?? "dumb",
		PI_TOOLSET_INNER: "1",
		PI_BRIDGE_SOCKET: "/run/pi-bridge/model.sock",
		PI_BRIDGE_TOKEN: options.token,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		PI_CODING_AGENT_DIR: "/run/pi-agent",
		// A fixed host name. The default would show the name of the host machine.
		HOSTNAME: HOST_NAME,
	};

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
	const relay = canonical(fileURLToPath(new URL("./inner-relay.ts", import.meta.url)));
	const workdir = canonical(resolve(options.cwd));
	const extensions = options.extensions.map((path) => {
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
	addMount(workdir, !options.readonly);
	for (const path of extensions) addMount(path, false);
	// The programs and their bin directories. A shell inside the sandbox must find them in
	// PATH, for example when a tool starts `node` itself.
	for (const path of [node, dirname(node), pi, dirname(pi), relay]) addMount(path, false);
	// `/etc` is mounted entry by entry. The account databases are generated instead of copied,
	// so host user names and home paths do not enter the sandbox.
	for (const entry of etcMounts(exists, options.etcFiles ?? ETC_FILES, options.etcDirectories ?? ETC_DIRECTORIES)) {
		addMount(entry.source, false);
	}
	// A worktree keeps its git directories outside the project. Git needs them to work, and
	// with the read-only layer off, git must also be able to write its index and objects.
	for (const path of gitDirectories(workdir, readText)) addMount(canonical(path), !options.readonly);
	const mounts = new Map<string, { source: string; writable: boolean }>();
	for (const path of writable.keys()) mounts.set(path, { source: path, writable: writable.get(path) === true });
	const system = systemMounts(exists, dependencies.readLink);
	const reserved = new Set(["/tmp", "/run", "/dev", "/proc", ...system.binds.map((bind) => bind.target)]);
	for (const path of mounts.keys()) {
		if (reserved.has(path)) throw new Error(`The sandbox cannot mount ${path}: the path belongs to the sandbox itself.`);
	}

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
		"--tmpfs",
		"/",
	];
	for (const bind of system.binds) args.push("--ro-bind", bind.source, bind.target);
	for (const link of system.symlinks) args.push("--symlink", link.target, link.path);
	// An empty `/etc`. The selected entries are bound below, and the relay writes the
	// generated account files before it starts Pi.
	args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/etc", "--dir", "/tmp/home");
	// `/proc/sys/kernel/random/boot_id` identifies the host boot. Node and OpenSSL read
	// `/dev/urandom` for entropy, so an empty directory here changes nothing else.
	args.push("--tmpfs", "/proc/sys/kernel/random");

	// A mount point must exist inside the sandbox before a bind targets it.
	const created = new Set([...reserved, "/tmp/home"]);
	for (const path of [...mounts.keys()].sort()) {
		for (const dir of parentDirectories(path)) {
			if (created.has(dir)) continue;
			created.add(dir);
			args.push("--dir", dir);
		}
	}
	for (const path of [...mounts.keys()].sort()) {
		args.push(mounts.get(path)!.writable ? "--bind" : "--ro-bind", path, path);
	}

	args.push(
		"--dir", "/run/pi-bridge",
		"--ro-bind", options.socketPath, env.PI_BRIDGE_SOCKET,
		"--dir", "/run/pi-agent",
		"--chdir", workdir,
		"--", node,
		relay, pi,
		"--mode", "rpc",
		"--no-session",
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
	);
	return { command, args, env };
}
