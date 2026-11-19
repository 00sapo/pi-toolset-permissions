import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultState } from "./state.ts";
import { detectSandboxTools, findExecutable, seatbeltProfile, shellQuote, wrapBash } from "./sandboxes.ts";
import type { SandboxTools } from "./sandboxes.ts";
import type { PermissionsState } from "./types.ts";

const TOOLS: SandboxTools = {
	bwrap: "/usr/bin/bwrap",
	unshare: "/usr/bin/unshare",
	sandboxExec: null,
	shell: "/bin/sh",
	platform: "linux",
};

const MACOS_TOOLS: SandboxTools = {
	bwrap: null,
	unshare: null,
	sandboxExec: "/usr/bin/sandbox-exec",
	shell: "/bin/sh",
	platform: "darwin",
};

function stateWith(change: (state: PermissionsState) => void): PermissionsState {
	const state = defaultState();
	change(state);
	return state;
}

function commandOf(plan: ReturnType<typeof wrapBash>): string {
	assert.ok(plan !== null && "command" in plan, `expected a command, got ${JSON.stringify(plan)}`);
	return plan.command;
}

test("both sandboxes are off by default", () => {
	const state = defaultState();
	assert.deepEqual(state.sandboxes, { filesystem: "off", no_network: false });
	assert.equal(wrapBash("ls", state, TOOLS), null);
});

test("shellQuote wraps a word and escapes single quotes", () => {
	assert.equal(shellQuote("ls -la"), "'ls -la'");
	assert.equal(shellQuote("echo 'x'"), "'echo '\\''x'\\'''");
	assert.equal(shellQuote(""), "''");
});

test("restricted Linux bash mounts project and extra roots, not host root", () => {
 const state = stateWith(s => {s.sandboxes.filesystem = "read+write"; s.scope="custom"; s.extra_paths = [tmpdir()];});
 const command = commandOf(wrapBash("ls",state,TOOLS,process.cwd()));
 assert.ok(command.includes("'--tmpfs' '/'"));
 assert.ok(command.includes(`'--bind' '${process.cwd()}' '${process.cwd()}'`));
 assert.ok(!command.includes("'--bind' '/' '/'"));
});
 test("macOS restricts reads and permits writes only in allowed roots", () => {
 const state = stateWith(s => {s.sandboxes.filesystem = "read+write"; s.scope="custom"; s.extra_paths = [tmpdir()];});
 const profile = seatbeltProfile(state,process.cwd());
 assert.ok(profile.includes("(deny file-read*)"));
 assert.ok(profile.includes("(deny file-write*)"));
 assert.ok(profile.includes(`(allow file-read* (subpath "${process.cwd()}"))`));
 assert.ok(profile.includes(`(allow file-write* (subpath "${process.cwd()}"))`));
 assert.ok(profile.includes('(allow file-read* (subpath "/System"))'));
 const read = seatbeltProfile({...state,sandboxes:{...state.sandboxes,filesystem:"read"}},process.cwd());
 assert.ok(!read.includes(`(allow file-write* (subpath "${process.cwd()}"))`));
});

test("macOS denies the network", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	assert.ok(seatbeltProfile(state).includes("(deny network*)"));
	assert.ok(!seatbeltProfile(state).includes("file-write"));
	assert.ok(commandOf(wrapBash("curl x", state, MACOS_TOOLS)).includes("(deny network*)"));
});

test("macOS without sandbox-exec fails closed", () => {
	const state = stateWith((current) => {
		current.sandboxes.filesystem = "read";
	});
	const plan = wrapBash("ls", state, { ...MACOS_TOOLS, sandboxExec: null });
	assert.ok(plan !== null && "error" in plan);
	assert.match(plan.error, /sandbox-exec/);
});

test("native Windows fails closed with WSL2 guidance", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	const plan = wrapBash("dir", state, { ...TOOLS, platform: "win32", shell: "cmd.exe" });
	assert.ok(plan !== null && "error" in plan);
	assert.match(plan.error, /WSL2/);
});

test("other platforms fail closed", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	const plan = wrapBash("ls", state, { ...TOOLS, platform: "freebsd" });
	assert.ok(plan !== null && "error" in plan);
	assert.match(plan.error, /not available/);
});

test("the no-network sandbox unshares the network namespace", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	const command = commandOf(wrapBash("curl https://example.com", state, TOOLS));
	assert.ok(command.startsWith("'/usr/bin/bwrap' --bind / / --dev /dev --proc /proc --unshare-net"));
	assert.ok(command.includes("-lc 'curl https://example.com'"));
});

test("both sandboxes combine", () => {
	const state = stateWith((current) => {
		current.sandboxes.filesystem = "read";
		current.sandboxes.no_network = true;
	});
	const command = commandOf(wrapBash("rm -rf x", state, TOOLS));
	assert.ok(command.includes("'--ro-bind'"));
 assert.ok(!command.includes("'--ro-bind' '/' '/'"));
	assert.ok(command.includes("--unshare-net"));
});

test("read-only without bubblewrap reports an error", () => {
	const state = stateWith((current) => {
		current.sandboxes.filesystem = "read";
	});
	const plan = wrapBash("ls", state, { bwrap: null, unshare: "/usr/bin/unshare", sandboxExec: null, shell: "/bin/sh", platform: "linux" });
	assert.ok(plan !== null && "error" in plan);
	assert.match(plan.error, /bubblewrap/);
});

test("no-network falls back to unshare", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	const command = commandOf(wrapBash("curl x", state, { bwrap: null, unshare: "/usr/bin/unshare", sandboxExec: null, shell: "/bin/sh", platform: "linux" }));
	assert.equal(command, "'/usr/bin/unshare' -n -- '/bin/sh' -lc 'curl x'");
});

test("no-network without any tool reports an error", () => {
	const state = stateWith((current) => {
		current.sandboxes.no_network = true;
	});
	const plan = wrapBash("curl x", state, { bwrap: null, unshare: null, sandboxExec: null, shell: "/bin/sh", platform: "linux" });
	assert.ok(plan !== null && "error" in plan);
	assert.match(plan.error, /bubblewrap/);
	assert.match(plan.error, /unshare/);
});

test("findExecutable finds a program in a PATH list", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-perm-"));
	try {
		const program = join(dir, "probe-bin");
		writeFileSync(program, "#!/bin/sh\n");
		chmodSync(program, 0o755);
		assert.equal(findExecutable("probe-bin", dir), program);
		assert.equal(findExecutable("probe-missing", dir), null);
		assert.equal(findExecutable("probe-bin", `${join(dir, "one")}:${join(dir, "two")}`), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("detectSandboxTools names the platform and a shell", () => {
	const tools = detectSandboxTools();
	assert.equal(tools.platform, process.platform);
	assert.equal(tools.shell, process.platform === "win32" ? "cmd.exe" : "/bin/sh");
	assert.ok(tools.bwrap === null || tools.bwrap.endsWith("bwrap"));
});

test("invalid scope fails closed and off does not canonicalize roots", () => {
 const state = stateWith(s=>{s.sandboxes.filesystem="read";s.scope="custom";s.extra_paths=["/"];});
 const plan = wrapBash("ls",state,TOOLS,process.cwd());
 assert.ok(plan && "error" in plan);
 state.sandboxes.filesystem="off";state.sandboxes.no_network=true;
 assert.ok(commandOf(wrapBash("ls",state,TOOLS,"/missing")).includes("--bind / /"));
});

test("macOS includes explicit Node runtime and Pi session exceptions", () => {
 const state = stateWith(s=>{s.sandboxes.filesystem="read";});
 const profile = seatbeltProfile(state,process.cwd());
 assert.ok(profile.includes('sessions"))'));
 assert.ok(profile.includes('settings.json"))'));
 assert.ok(profile.includes('models.json"))'));
 assert.ok(!profile.includes('auth.json'));
});

test("live Linux bash permits project writes but blocks outside access", async (t) => {
 const {spawnSync} = await import("node:child_process");
 const {mkdirSync,readFileSync} = await import("node:fs");
 const probe = spawnSync("bwrap",["--bind","/","/","--unshare-net","--","/bin/true"],{encoding:"utf8"});
 if(probe.status !== 0) return t.skip(`bubblewrap namespaces unavailable: ${probe.stderr ?? probe.error}`);
 const dir = mkdtempSync(join(tmpdir(),"pi-wrap-live-"));
 const project = join(dir,"project");const outside = join(dir,"outside");
 mkdirSync(project);mkdirSync(outside);writeFileSync(join(outside,"secret"),"hidden");
 try {
  for(const filesystem of ["read","read+write","off"] as const) {
   const state = stateWith(s=>{s.sandboxes.filesystem=filesystem;s.sandboxes.no_network=true;});
   const command = filesystem === "read" ? "! touch ./new && ! cat ../outside/secret" : filesystem === "read+write" ? "echo project > ./new && ! cat ../outside/secret" : "echo host > ../outside/new";
   const plan = wrapBash(command,state,TOOLS,project);
   const result = spawnSync("/bin/sh",["-c",commandOf(plan)],{cwd:project,encoding:"utf8"});
   assert.equal(result.status,0,`${filesystem}: ${result.stderr}`);
  }
  assert.equal(readFileSync(join(project,"new"),"utf8"),"project\n");
  assert.equal(readFileSync(join(outside,"new"),"utf8"),"host\n");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("Linux and macOS filesystem roots honor project-only and custom modes", () => {
 const extra = mkdtempSync(join(tmpdir(), "pi-scope-extra-"));
 try {
  for (const scope of ["project", "custom", "project"] as const) {
   const state = stateWith(s => { s.scope = scope; s.extra_paths = [extra]; s.sandboxes.filesystem = "read+write"; });
   const command = commandOf(wrapBash("ls", state, TOOLS, process.cwd()));
   const profile = seatbeltProfile(state, process.cwd());
   assert.equal(command.includes(`'--bind' '${extra}' '${extra}'`), scope === "custom");
   assert.equal(profile.includes(`(allow file-read* (subpath "${extra}"))`), scope === "custom");
   assert.equal(profile.includes(`(allow file-write* (subpath "${extra}"))`), scope === "custom");
  }
 } finally { rmSync(extra, { recursive: true, force: true }); }
});
