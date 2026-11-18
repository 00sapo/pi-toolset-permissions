import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_NAME, accountFiles, buildIsolatedLaunch, parentDirectories, systemMounts } from "./isolated-launcher.ts";

const options = {
	socketPath: "/tmp/private bridge/model.sock", token: "test-token", cwd: "/workspace/project",
	extensions: ["./extension one.ts", "/opt/extensions/two.ts"], readonly: true, network: true,
};

/** A host layout with a merged `/usr`, the usual Linux shape since merged-usr. */
const hostExists = (path: string): boolean =>
	["/usr", "/etc", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ssl", "/bin", "/sbin", "/lib", "/lib64", "/tmp", "/run", "/dev", "/proc"].includes(path);
const hostLinks: Record<string, string> = { "/bin": "usr/bin", "/sbin": "usr/sbin", "/lib": "usr/lib", "/lib64": "usr/lib64" };

const dependencies = {
	platform: "linux" as NodeJS.Platform,
	env: { PATH: "/usr/bin:/bin", HOME: "/home/test", LANG: "C.UTF-8", TERM: "xterm", OPENAI_API_KEY: "real-secret", NODE_OPTIONS: "--require evil", HTTP_PROXY: "http://host", PI_CODING_AGENT_DIR: "/host/credentials", PI_TOOLSET_INNER: "wrong" },
	findExecutable: (name: string) => ({ bwrap: "/usr/bin/bwrap", pi: "/opt/pi/bin/pi", node: "/usr/bin/node" }[name] ?? (name.startsWith("/") ? name : null)),
	realPath: (path: string) => path,
	exists: hostExists,
	readLink: (path: string) => hostLinks[path] ?? null,
};
const relay = fileURLToPath(new URL("./inner-relay.ts", import.meta.url));
const sandboxSocket = "/run/pi-bridge/model.sock";

const mounts = (args: string[]): Array<{ mode: string; source: string; target: string }> => {
	const found: Array<{ mode: string; source: string; target: string }> = [];
	const body = args.slice(0, args.indexOf("--"));
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "--ro-bind" || body[index] === "--bind") {
			found.push({ mode: body[index], source: body[index + 1], target: body[index + 2] });
			index += 2;
		}
	}
	return found;
};

test("the root starts empty instead of binding the host root", () => {
	const { args } = buildIsolatedLaunch(options, dependencies);
	const root = args.indexOf("--tmpfs");
	assert.equal(root, args.indexOf("--tmpfs", 0));
	assert.equal(args[root + 1], "/");
	for (const bind of mounts(args)) assert.notEqual(bind.source, "/");
	assert.equal(args.includes("--ro-bind"), true);
	assert.equal(args.slice(0, args.indexOf("--")).filter((arg) => arg === "/").length, 1);
});

test("home, credentials, and other users stay out of the sandbox", () => {
	const { args } = buildIsolatedLaunch(options, dependencies);
	// The relay file and the project are code and work data, and a project usually sits
	// below /home. Every other path in that tree must stay out of the sandbox.
	const allowed = new Set([relay, "/workspace/project", "/workspace/project/extension one.ts", "/usr/bin", "/opt/pi/bin"]);
	for (const hidden of ["/home", "/root", "/mnt", "/media", "/srv", "/var"]) {
		for (const bind of mounts(args)) {
			if (allowed.has(bind.source)) continue;
			assert.notEqual(bind.source, hidden);
			assert.equal(bind.source.startsWith(`${hidden}/`), false, `${hidden} leaked through ${bind.source}`);
		}
	}
	assert.ok(args.includes("/home"), "the sandbox needs an empty /home directory");
	assert.equal(mounts(args).some((bind) => bind.target === "/home"), false);
	assert.equal(args.includes("/root"), false);
});

test("only the system directories, the executables, the project, and the extensions are mounted", () => {
	const { args } = buildIsolatedLaunch(options, dependencies);
	assert.deepEqual(mounts(args).map((bind) => bind.source).sort(), [
		"/etc/nsswitch.conf", "/etc/ssl", "/opt/extensions/two.ts", "/opt/pi/bin", "/opt/pi/bin/pi", "/usr", "/usr/bin",
		"/usr/bin/node", relay, "/workspace/project", "/workspace/project/extension one.ts", options.socketPath,
	].sort());
});

test("the project mount follows the read-only layer and the extensions stay read-only", () => {
	for (const readonly of [true, false]) {
		const { args } = buildIsolatedLaunch({ ...options, readonly }, dependencies);
		const found = mounts(args);
		const project = found.find((bind) => bind.source === "/workspace/project");
		assert.equal(project?.mode, readonly ? "--ro-bind" : "--bind");
		for (const path of ["/workspace/project/extension one.ts", "/opt/extensions/two.ts", "/opt/pi/bin/pi", "/usr/bin/node", relay]) {
			assert.equal(found.find((bind) => bind.source === path)?.mode, "--ro-bind", path);
		assert.equal(found.find((bind) => bind.source === "/usr/bin")?.mode, "--ro-bind", "/usr/bin");
		}
	}
});

test("network isolation adds --unshare-net and nothing else changes", () => {
	const isolated = buildIsolatedLaunch({ ...options, network: true }, dependencies);
	const open = buildIsolatedLaunch({ ...options, network: false }, dependencies);
	assert.equal(isolated.args[0], "--unshare-net");
	assert.deepEqual(open.args, isolated.args.slice(1));
	assert.deepEqual(open.env, isolated.env);
	assert.equal(isolated.args.filter((arg) => arg === "--unshare-net").length, 1);
	assert.equal(open.args.includes("--unshare-net"), false);
});

test("IPC, host name, and process IDs are separated, and the host name is fixed", () => {
	for (const network of [true, false]) {
		const { args } = buildIsolatedLaunch({ ...options, network }, dependencies);
		const body = args.slice(0, args.indexOf("--"));
		for (const flag of ["--unshare-ipc", "--unshare-uts", "--unshare-pid", "--new-session"]) assert.ok(body.includes(flag), flag);
		assert.equal(body[body.indexOf("--hostname") + 1], HOST_NAME);
		assert.equal(body[body.indexOf("--hostname") - 1], "--unshare-uts");
	}
});

test("process IDs, the socket, and the agent directory stay private in both modes", () => {
	for (const network of [true, false]) {
		const { args, env } = buildIsolatedLaunch({ ...options, network }, dependencies);
		const sandboxArgs = args.slice(0, args.indexOf("--"));
		assert.ok(sandboxArgs.includes("--unshare-pid"));
		assert.equal(sandboxArgs[sandboxArgs.indexOf("--proc") + 1], "/proc");
		assert.ok(sandboxArgs.includes("--die-with-parent"));
		assert.ok(sandboxArgs.includes("--new-session"));
		const socket = mounts(args).find((bind) => bind.source === options.socketPath);
		assert.deepEqual(socket, { mode: "--ro-bind", source: options.socketPath, target: sandboxSocket });
		assert.equal(env.PI_CODING_AGENT_DIR, "/run/pi-agent");
		assert.equal(args.includes("/run/pi-agent"), true);
	}
});

test("every bind target has a mount point created before it", () => {
	const { args } = buildIsolatedLaunch({ ...options, network: true }, dependencies);
	const body = args.slice(0, args.indexOf("--"));
	const existing = new Set(["/", "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/tmp", "/run", "/dev", "/proc", "/tmp/home", "/run/pi-bridge", "/run/pi-agent"]);
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "--dir") existing.add(body[index + 1]);
		if (body[index] === "--tmpfs") existing.add(body[index + 1]);
		if (body[index] === "--dev" || body[index] === "--proc") existing.add(body[index + 1]);
		if (body[index] === "--symlink") existing.add(body[index + 2]);
		if (body[index] === "--ro-bind" || body[index] === "--bind") {
			// A directory bind needs its own mount point. A file bind needs its parent only.
			const target = body[index + 2];
			const parent = parentDirectories(target).at(-1) ?? "/";
			assert.ok(existing.has(parent), `no mount point for ${target}`);
			existing.add(target);
			index += 2;
		}
	}
});

test("parentDirectories lists every parent from the top down", () => {
	assert.deepEqual(parentDirectories("/a/b/c"), ["/a", "/a/b"]);
	assert.deepEqual(parentDirectories("/a"), []);
	assert.deepEqual(parentDirectories("/a/"), []);
});

test("a merged /usr becomes symlinks and a split layout becomes binds", () => {
	const merged = systemMounts(hostExists, (path) => hostLinks[path] ?? null);
	assert.deepEqual(merged.binds.map((bind) => bind.target), ["/usr"]);
	assert.deepEqual(merged.symlinks, [
		{ target: "usr/bin", path: "/bin" }, { target: "usr/sbin", path: "/sbin" },
		{ target: "usr/lib", path: "/lib" }, { target: "usr/lib64", path: "/lib64" },
	]);
	const split = systemMounts((path) => ["/bin", "/lib", "/lib64", "/sbin"].includes(path), () => null);
	assert.deepEqual(split.binds.map((bind) => bind.target), ["/bin", "/sbin", "/lib", "/lib64"]);
	assert.deepEqual(split.symlinks, []);
});

test("rejects a non-boolean layer instead of guessing a default", () => {
	for (const network of [undefined, null, 0, 1, "true", "false", {}, []]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, network } as any, dependencies), /network must be a boolean/, String(network));
	}
	for (const readonly of [undefined, null, 0, 1, "true"]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, readonly } as any, dependencies), /readonly must be a boolean/, String(readonly));
	}
});

test("environment is an allowlist, not inherited credentials or loader settings", () => {
	const plan = buildIsolatedLaunch(options, dependencies);
	assert.deepEqual(plan.env, {
		PATH: "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin", HOME: "/tmp/home", LANG: "C.UTF-8", TERM: "xterm",
		PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: "/run/pi-agent", HOSTNAME: HOST_NAME,
	});
	assert.deepEqual(buildIsolatedLaunch(options, { ...dependencies, env: {} }).env, {
		PATH: "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin", HOME: "/tmp/home", LANG: "C.UTF-8", TERM: "dumb",
		PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: "/run/pi-agent", HOSTNAME: HOST_NAME,
	});
	if (hostname() !== HOST_NAME) assert.equal(JSON.stringify(plan).includes(hostname()), false, "the host name must not reach the sandbox");
	for (const name of ["OPENAI_API_KEY", "NODE_OPTIONS", "HTTP_PROXY", "LD_PRELOAD", "PI_CODING_AGENT_DIR_HOST"]) {
		assert.equal(name in plan.env, false, name);
	}
});

test("the token travels in the environment and never in argv", () => {
	const { args, env } = buildIsolatedLaunch(options, dependencies);
	assert.equal(args.includes(options.token), false);
	assert.equal(env.PI_BRIDGE_TOKEN, options.token);
	assert.equal(args.includes(options.socketPath), true);
});

test("unsupported platforms and missing executables fail closed", () => {
	for (const platform of ["darwin", "win32"] as const) {
		assert.throws(() => buildIsolatedLaunch(options, { ...dependencies, platform }), /Linux/);
	}
	for (const missing of ["bwrap", "pi", "node", "/missing/pi", "/missing/node"]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, ...(missing.endsWith("/pi") ? { piPath: missing } : {}), ...(missing.endsWith("/node") ? { nodePath: missing } : {}) }, {
			...dependencies, findExecutable: (name: string) => name === missing ? null : dependencies.findExecutable(name),
		}), /executable/);
	}
});

test("rejects invalid socket, cwd, token, and extension arguments", () => {
	for (const change of [{ socketPath: "relative.sock" }, { cwd: "relative" }, { token: "" }, { token: "a\nb" }, { extensions: ["builtin:mcp"] }, { extensions: [""] }, { cwd: "/bad\0path" }]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, ...change }, dependencies));
	}
});

test("refuses to mount a path that belongs to the sandbox itself", () => {
	assert.throws(() => buildIsolatedLaunch({ ...options, cwd: "/tmp", extensions: [] }, dependencies), /belongs to the sandbox/);
});

test("does not mutate caller input or dependencies", () => {
	const before = JSON.stringify({ options, env: dependencies.env });
	assert.deepEqual(buildIsolatedLaunch(options, dependencies), buildIsolatedLaunch(options, dependencies));
	assert.equal(JSON.stringify({ options, env: dependencies.env }), before);
});

test("a worktree git directory outside the project is mounted read-only", () => {
	const files: Record<string, string> = {
		"/workspace/project/.git": "gitdir: /repo/.git/worktrees/project\n",
		"/repo/.git/worktrees/project/commondir": "../..\n",
	};
	const readText = (path: string) => files[path] ?? null;
	const { args } = buildIsolatedLaunch(options, { ...dependencies, readText });
	const found = mounts(args);
	for (const path of ["/repo/.git/worktrees/project", "/repo/.git"]) {
		assert.deepEqual(found.find((bind) => bind.source === path), { mode: "--ro-bind", source: path, target: path }, path);
	}
	const open = buildIsolatedLaunch({ ...options, readonly: false }, { ...dependencies, readText });
	const writable = mounts(open.args).find((bind) => bind.source === "/repo/.git/worktrees/project");
	assert.equal(writable?.mode, "--bind", "git must be writable when the read-only layer is off");
});

test("a plain repository needs no extra git mount", () => {
	const { args } = buildIsolatedLaunch(options, { ...dependencies, readText: () => null });
	assert.deepEqual(mounts(args).filter((bind) => bind.source.includes(".git")), []);
	assert.deepEqual(buildIsolatedLaunch(options, { ...dependencies, readText: () => "gitdir: .git/main\n" }).args, buildIsolatedLaunch(options, { ...dependencies, readText: () => null }).args);
});

test("the mounted PATH contains only directories that exist inside the sandbox", () => {
	const { args, env } = buildIsolatedLaunch(options, dependencies);
	assert.equal(env.PATH, "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin");
	// No host directory appears in PATH. The relay links the programs into /run/pi-bin.
	assert.equal(env.PATH.includes("/opt/pi/bin"), false);
	assert.equal(env.PATH.includes("/usr/bin/node"), false);
	const body = args.slice(0, args.indexOf("--"));
	assert.ok(body.includes("/usr/bin"));
	assert.ok(body.includes("/opt/pi/bin"));
});

test("a distribution without a merged /usr and without alternatives still launches", () => {
	// Alpine, and older layouts: /bin and /lib are real directories, and /etc/alternatives is absent.
	const exists = (path: string) => ["/usr", "/bin", "/lib", "/etc/nsswitch.conf", "/tmp", "/run", "/dev", "/proc"].includes(path);
	const layout = { ...dependencies, exists, readLink: () => null };
	const { args } = buildIsolatedLaunch(options, layout);
	const found = mounts(args);
	assert.deepEqual(found.filter((bind) => ["/bin", "/lib", "/usr"].includes(bind.source)).map((bind) => bind.mode), ["--ro-bind", "--ro-bind", "--ro-bind"]);
	assert.equal(args.includes("--symlink"), false, "no symlink is needed when the directories are real");
	assert.equal(found.some((bind) => bind.source.includes("alternatives")), false);
	assert.deepEqual(found.filter((bind) => bind.source.startsWith("/etc/")).map((bind) => bind.source), ["/etc/nsswitch.conf"]);
});

test("missing /etc entries are skipped instead of failing the launch", () => {
	const { args } = buildIsolatedLaunch(options, { ...dependencies, exists: (path: string) => path !== "/etc/nsswitch.conf" && hostExists(path) });
	assert.equal(mounts(args).some((bind) => bind.source === "/etc/nsswitch.conf"), false);
	const at = args.indexOf("/etc");
	assert.equal(args[at - 1], "--tmpfs", "/etc is still an empty directory");
});
