import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_NAME, HOME_AGENT_DIR, accountFiles, buildIsolatedLaunch, parentDirectories, systemMounts } from "./isolated-launcher.ts";

const options = {
	socketPath: "/tmp/private bridge/model.sock", token: "test-token", cwd: "/workspace/project",
	extensions: ["./extension one.ts", "/opt/extensions/two.ts"], filesystem: "read" as const, paths: ["/workspace/project"], network: true,
};

/** A host layout with a merged `/usr`, the usual Linux shape since merged-usr. */
const hostExists = (path: string): boolean =>
	["/usr", "/etc", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ssl/certs", "/bin", "/sbin", "/lib", "/lib64", "/tmp", "/run", "/dev", "/proc"].includes(path);
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
		if (body[index] === "--ro-bind" || body[index] === "--bind" || body[index] === "--dev-bind") {
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
		"/etc/nsswitch.conf", "/etc/ssl/certs", "/opt/extensions/two.ts", "/opt/pi/bin", "/opt/pi/bin/pi", "/usr", "/usr/bin",
		"/usr/bin/node", relay, "/workspace/project", "/workspace/project/extension one.ts", options.socketPath,
	].sort());
});

test("the project mount follows the read-only layer and the extensions stay read-only", () => {
	for (const filesystem of ["read", "read+write"] as const) {
		const { args } = buildIsolatedLaunch({ ...options, filesystem }, dependencies);
		const found = mounts(args);
		const project = found.find((bind) => bind.source === "/workspace/project");
		assert.equal(project?.mode, filesystem === "read" ? "--ro-bind" : "--bind");
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
		assert.equal(env.PI_CODING_AGENT_DIR, "/run/pi-agent-private");
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
	for (const filesystem of [undefined, null, 0, 1, "true"]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, filesystem } as any, dependencies), /filesystem/, String(filesystem));
	}
});

test("environment is an allowlist, not inherited credentials or loader settings", () => {
	const plan = buildIsolatedLaunch(options, dependencies);
	assert.deepEqual(plan.env, {
		PATH: "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin", HOME: "/run/pi-home", LANG: "C.UTF-8", TERM: "xterm",
		PI_TOOLSET_INNER: "1", PI_BRIDGE_GENERATE_ACCOUNTS: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: "/run/pi-agent-private", HOSTNAME: HOST_NAME,
	});
	assert.deepEqual(buildIsolatedLaunch(options, { ...dependencies, env: {} }).env, {
		PATH: "/run/pi-bin:/usr/bin:/bin:/usr/local/bin:/opt/local/bin", HOME: "/run/pi-home", LANG: "C.UTF-8", TERM: "dumb",
		PI_TOOLSET_INNER: "1", PI_BRIDGE_GENERATE_ACCOUNTS: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: "/run/pi-agent-private", HOSTNAME: HOST_NAME,
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
	assert.throws(() => buildIsolatedLaunch({ ...options, cwd: "/run", paths: ["/run"], extensions: [] }, dependencies), /protected path/);
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
	const gitPaths = new Set(["/repo/.git/worktrees/project/HEAD", "/repo/.git/worktrees/project/commondir", "/repo/.git/objects"]);
	const gitLayout = { ...dependencies, readText, exists: (path: string) => gitPaths.has(path) || hostExists(path) };
	const { args } = buildIsolatedLaunch(options, gitLayout);
	const found = mounts(args);
	for (const path of ["/repo/.git/worktrees/project", "/repo/.git"]) {
		assert.deepEqual(found.find((bind) => bind.source === path), { mode: "--ro-bind", source: path, target: path }, path);
	}
	const open = buildIsolatedLaunch({ ...options, filesystem: "read+write" }, gitLayout);
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

 test("off binds the host root writable even with network isolation", () => {
 const {args} = buildIsolatedLaunch({...options, filesystem: "off"}, dependencies);
 // `--dev-bind` keeps device nodes usable. A plain `--bind` of the root makes an
 // executable spawn fail with EACCES inside the sandbox.
 assert.deepEqual(mounts(args).find(x => x.target === "/"), {mode: "--dev-bind", source: "/", target: "/"});
 assert.ok(args.includes("--unshare-net"));
 assert.equal(args.includes("/etc"), false);
 assert.equal(args.includes("/tmp"), false);
 });
 test("custom roots canonicalize and follow the selected mode", () => {
 for (const filesystem of ["read", "read+write"] as const) {
 const {args} = buildIsolatedLaunch({...options, filesystem, paths:[options.cwd,"/alias"]}, {...dependencies, realPath:p=>p === "/alias" ? "/data/custom" : p});
 assert.equal(mounts(args).find(x=>x.source === "/data/custom")?.mode, filesystem === "read" ? "--ro-bind" : "--bind");
 assert.equal(args.includes("/alias"),false);
 }
 });
 test("restricted roots reject protected ancestors and descendants", () => {
 for (const path of ["/", "/run", "/run/host", "/proc/self", "/dev", "/usr", "/usr/local", "/etc", "/etc/passwd"]) {
 assert.throws(()=>buildIsolatedLaunch({...options, paths:[options.cwd,path]},dependencies), /sandbox|protected|off/);
 }
 assert.throws(()=>buildIsolatedLaunch({...options, paths:["/alias"]},{...dependencies, realPath:p=>p === "/alias" ? "/run/secrets" : p}), /sandbox|protected/);
 });
 test("cwd must belong to an allowed root", () => {
 assert.throws(()=>buildIsolatedLaunch({...options,paths:["/other"]},dependencies), /cwd/);
 });

test("live bwrap enforces scoped roots and leaves off mode host files writable", async (t) => {
 const {spawnSync} = await import("node:child_process");
 const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync} = await import("node:fs");
 const {tmpdir} = await import("node:os");
 const {join} = await import("node:path");
 const probe = spawnSync("bwrap", ["--bind", "/", "/", "--unshare-net", "--", "/bin/true"], {encoding:"utf8"});
 if (probe.status !== 0) return t.skip(`bubblewrap namespaces unavailable: ${probe.stderr ?? probe.error}`);
 const dir = mkdtempSync(join(tmpdir(),"pi-scoped-backend-"));
 const project = join(dir,"project"), custom = join(dir,"custom"), outside = join(dir,"outside");
 for (const root of [project,custom,outside]) {mkdirSync(root);writeFileSync(join(root,"data"),"original");}
 symlinkSync(join(outside,"data"),join(project,"escape"));
 try {
  for (const filesystem of ["read","read+write","off"] as const) {
   const plan = buildIsolatedLaunch({socketPath:join(outside,"data"),token:"live-token",cwd:project,extensions:[],filesystem,paths:[project,custom],network:true,piPath:process.execPath,nodePath:process.execPath});
   const script = `const fs=require('fs'); const roots=${JSON.stringify([project,custom,outside])}; const mode=${JSON.stringify(filesystem)}; for(let i=0;i<roots.length;i++){const p=roots[i]+'/data'; let readable=true;try{fs.readFileSync(p)}catch{readable=false} if(readable !== (mode==='off'||i<2))process.exit(10+i);let writable=true;try{fs.writeFileSync(p,'changed')}catch{writable=false}if(writable !== (mode==='off'||(mode==='read+write'&&i<2)))process.exit(20+i);} if(mode!=='off'&&fs.existsSync(roots[0]+'/escape'))process.exit(30);`;
   const args = [...plan.args.slice(0,plan.args.indexOf("--")),"--",process.execPath,"-e",script];
   const result = spawnSync(plan.command,args,{env:plan.env,encoding:"utf8"});
   assert.equal(result.status,0,`${filesystem}: ${result.stderr}`);
  }
  assert.equal(readFileSync(join(outside,"data"),"utf8"),"changed");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("a crafted .git pointer cannot mount an arbitrary host directory", () => {
	const files: Record<string, string> = {
		"/workspace/project/.git": "gitdir: /home/alice/.ssh\n",
	};
	const { args } = buildIsolatedLaunch(options, { ...dependencies, readText: (path) => files[path] ?? null, exists: (path) => path !== "/home/alice/.ssh/HEAD" });
	assert.deepEqual(mounts(args).filter((bind) => bind.source.includes("alice")), []);
});

test("the Pi configuration directory is mounted read-only, at both paths", () => {
	const agentDir = "/home/test/.pi/agent";
	const agentPaths = new Set([
		`${agentDir}/settings.json`, `${agentDir}/subagents.json`, `${agentDir}/APPEND_SYSTEM.md`,
		`${agentDir}/rules`, `${agentDir}/agents`, `${agentDir}/extensions`, `${agentDir}/npm`,
	]);
	const layout = { ...dependencies, exists: (path: string) => agentPaths.has(path) || hostExists(path) };
	const { args } = buildIsolatedLaunch({ ...options, piAgentDir: agentDir }, layout);
	const found = mounts(args);
	for (const source of agentPaths) {
		assert.deepEqual(found.find((entry) => entry.source === source && entry.target === source), { mode: "--ro-bind", source, target: source }, source);
		const mirror = found.find((entry) => entry.source === source && entry.target.startsWith(HOME_AGENT_DIR));
		assert.deepEqual(mirror, { mode: "--ro-bind", source, target: `${HOME_AGENT_DIR}/${source.slice(agentDir.length + 1)}` }, source);
	}
});

test("the relay learns which configuration entries to link into the private directory", () => {
	const agentDir = "/home/test/.pi/agent";
	const layout = { ...dependencies, exists: (path: string) => path.startsWith(agentDir) || hostExists(path) };
	const { env } = buildIsolatedLaunch({ ...options, piAgentDir: agentDir }, layout);
	assert.equal(env.PI_BRIDGE_HOST_AGENT_DIR, agentDir);
	const names = env.PI_BRIDGE_AGENT_ENTRIES.split(",");
	assert.ok(names.includes("rules") && names.includes("agents") && names.includes("npm"), env.PI_BRIDGE_AGENT_ENTRIES);
	assert.equal(names.some((name) => name.includes("/")), false, "only top-level entries are named");
	// No configuration means no link list, and the relay writes its own files.
	const bare = buildIsolatedLaunch(options, layout).env;
	assert.equal(bare.PI_BRIDGE_HOST_AGENT_DIR, undefined);
	assert.equal(bare.PI_BRIDGE_AGENT_ENTRIES, undefined);
});

test("the Pi configuration mount leaves credentials, sessions, and caches outside", () => {
	const agentDir = "/home/test/.pi/agent";
	const everything = { ...dependencies, exists: (path: string) => path.startsWith(agentDir) || hostExists(path) };
	const { args } = buildIsolatedLaunch({ ...options, piAgentDir: agentDir }, everything);
	for (const bind of mounts(args)) {
		for (const secret of ["auth.json", "models-store.json", "trust.json", "sessions", "state", ".credentials"]) {
			assert.equal(bind.source.includes(`/${secret}`), false, `${secret} leaked through ${bind.source}`);
		}
	}
});

test("the agent directory is optional and follows the filesystem layer", () => {
	const agentDir = "/home/test/.pi/agent";
	const layout = { ...dependencies, exists: (path: string) => path.startsWith(agentDir) || hostExists(path) };
	assert.equal(mounts(buildIsolatedLaunch(options, layout).args).some((bind) => bind.source.startsWith(agentDir)), false);
	const open = buildIsolatedLaunch({ ...options, filesystem: "off", piAgentDir: agentDir }, layout);
	assert.equal(mounts(open.args).some((bind) => bind.source.startsWith(agentDir)), false, "the host tree is already visible");
});

test("every agent-directory mirror has a mount point", () => {
	const agentDir = "/home/test/.pi/agent";
	const layout = { ...dependencies, exists: (path: string) => path.startsWith(agentDir) || hostExists(path) };
	const { args } = buildIsolatedLaunch({ ...options, piAgentDir: agentDir }, layout);
	const body = args.slice(0, args.indexOf("--"));
	const existing = new Set(["/", "/run", "/run/pi-home"]);
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "--dir" || body[index] === "--tmpfs") existing.add(body[index + 1]);
		if (body[index] === "--ro-bind" || body[index] === "--bind") {
			const target = body[index + 2];
			if (target.startsWith(HOME_AGENT_DIR)) assert.ok(existing.has(parentDirectories(target).at(-1) ?? "/"), `no mount point for ${target}`);
			existing.add(target);
			index += 2;
		}
	}
	assert.ok(existing.has(HOME_AGENT_DIR), "the mirrored configuration directory exists");
});

test("a real worktree git directory is still mounted", () => {
	const files: Record<string, string> = {
		"/workspace/project/.git": "gitdir: /repo/.git/worktrees/project\n",
		"/repo/.git/worktrees/project/commondir": "../..\n",
	};
	const real = new Set(["/repo/.git/worktrees/project/HEAD", "/repo/.git/worktrees/project/commondir", "/repo/.git/objects"]);
	const { args } = buildIsolatedLaunch(options, {
		...dependencies, readText: (path) => files[path] ?? null, exists: (path) => real.has(path) || hostExists(path),
	});
	const sources = mounts(args).map((bind) => bind.source);
	assert.ok(sources.includes("/repo/.git/worktrees/project"), "the worktree git directory is mounted");
	assert.ok(sources.includes("/repo/.git"), "the shared object directory is mounted");
});
