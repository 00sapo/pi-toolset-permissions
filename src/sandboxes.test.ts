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
	assert.deepEqual(state.sandboxes, { readonly_bash: false, no_network: false });
	assert.equal(wrapBash("ls", state, TOOLS), null);
});

test("shellQuote wraps a word and escapes single quotes", () => {
	assert.equal(shellQuote("ls -la"), "'ls -la'");
	assert.equal(shellQuote("echo 'x'"), "'echo '\\''x'\\'''");
	assert.equal(shellQuote(""), "''");
});

test("the read-only sandbox binds the root read-only", () => {
	const state = stateWith((current) => {
		current.sandboxes.readonly_bash = true;
	});
	const command = commandOf(wrapBash("ls -la", state, TOOLS));
	assert.ok(command.startsWith("'/usr/bin/bwrap' --ro-bind / / --dev /dev --proc /proc"));
	assert.ok(command.includes("--die-with-parent -- '/bin/sh' -lc 'ls -la'"));
	assert.ok(!command.includes("--unshare-net"));
});

test("macOS uses Seatbelt and denies file writes", () => {
	const state = stateWith((current) => {
		current.sandboxes.readonly_bash = true;
	});
	assert.equal(
		seatbeltProfile(state),
		'(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (literal "/dev/stdout"))(allow file-write* (literal "/dev/stderr"))(allow file-write* (literal "/dev/tty"))',
	);
	const command = commandOf(wrapBash("touch x", state, MACOS_TOOLS));
	assert.ok(command.startsWith("'/usr/bin/sandbox-exec' -p '"));
	assert.ok(command.includes("(deny file-write*)"));
	assert.ok(command.endsWith(" '/bin/sh' -lc 'touch x'"));
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
		current.sandboxes.readonly_bash = true;
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
		current.sandboxes.readonly_bash = true;
		current.sandboxes.no_network = true;
	});
	const command = commandOf(wrapBash("rm -rf x", state, TOOLS));
	assert.ok(command.includes("--ro-bind / /"));
	assert.ok(command.includes("--unshare-net"));
});

test("read-only without bubblewrap reports an error", () => {
	const state = stateWith((current) => {
		current.sandboxes.readonly_bash = true;
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
