import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PERMISSIONS_TOOL_NAME, evaluateCall } from "./gate.ts";
import { defaultState } from "./state.ts";
import type { GateDecision, PermissionsState } from "./types.ts";

interface Workspace {
	root: string;
	project: string;
	outside: string;
	cleanup: () => void;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "pi-perm-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	writeFileSync(join(project, "file.txt"), "x");
	writeFileSync(join(outside, "secret.txt"), "x");
	return { root, project, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withWorkspace(run: (space: Workspace) => void): void {
	const space = workspace();
	try {
		run(space);
	} finally {
		space.cleanup();
	}
}

function stateWith(mutate: (state: PermissionsState) => void = () => {}): PermissionsState {
	const state = defaultState();
	mutate(state);
	return state;
}

function reasonOf(decision: GateDecision): string {
	assert.equal(decision.block, true, "expected the call to be blocked");
	if (!decision.block) return "";
	return decision.reason;
}

test("the permissions tool is always allowed", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags = { read: false, write: false, execute: false };
			current.sandboxes = { readonly_bash: true, no_network: true };
		});
		const decision = evaluateCall(state, PERMISSIONS_TOOL_NAME, { path: "/etc/passwd" }, space.project);
		assert.equal(decision.block, false);
	});
});

test("an unknown tool is blocked so the caller can ask", () => {
	withWorkspace((space) => {
		const decision = evaluateCall(stateWith(), "frobnicate", {}, space.project);
		assert.equal(decision.block, true);
		if (!decision.block) return;
		assert.equal(decision.kind, "unknown");
		assert.match(decision.reason, /^Blocked: /);
		assert.ok(decision.reason.includes("frobnicate"));
		assert.ok(decision.reason.includes("no toolset"));
	});
});

test("read is blocked when the read flag is off", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.read = false;
		});
		const reason = reasonOf(evaluateCall(state, "read", { path: join(space.project, "file.txt") }, space.project));
		assert.ok(reason.includes('"read"'));
		assert.ok(reason.includes("set_flag"));
	});
});

test("read is allowed when the read flag is on", () => {
	withWorkspace((space) => {
		const decision = evaluateCall(stateWith(), "read", { path: join(space.project, "file.txt") }, space.project);
		assert.equal(decision.block, false);
	});
});

test("write is blocked when the write flag is off", () => {
	withWorkspace((space) => {
		const reason = reasonOf(
			evaluateCall(stateWith(), "write", { path: join(space.project, "file.txt") }, space.project),
		);
		assert.ok(reason.includes('"write"'));
		assert.ok(reason.includes("set_flag"));
	});
});

test("write is allowed when the write flag is on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
		});
		const decision = evaluateCall(state, "write", { path: join(space.project, "new.txt") }, space.project);
		assert.equal(decision.block, false);
	});
});

test("execute is blocked when the execute flag is off", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.execute = false;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "ls -la" }, space.project));
		assert.ok(reason.includes('"execute"'));
		assert.ok(reason.includes("set_flag"));
	});
});

test("a path outside the project scope is blocked", () => {
	withWorkspace((space) => {
		const value = join(space.outside, "secret.txt");
		const reason = reasonOf(evaluateCall(stateWith(), "read", { path: value }, space.project));
		assert.ok(reason.includes(value));
		assert.ok(reason.includes("outside the allowed roots"));
	});
});

test("an extra path is allowed", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.extra_paths = [space.outside];
		});
		const value = join(space.outside, "secret.txt");
		assert.equal(evaluateCall(state, "read", { path: value }, space.project).block, false);
	});
});

test("everywhere allows any path", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.scope = "everywhere";
		});
		const value = join(space.outside, "secret.txt");
		assert.equal(evaluateCall(state, "read", { path: value }, space.project).block, false);
	});
});

test("bash is one tool and ignores the file path scope", () => {
	withWorkspace((space) => {
		assert.equal(evaluateCall(stateWith(), "bash", { command: "cat /etc/passwd" }, space.project).block, false);
	});
});

test("bash ignores the file path scope in everywhere too", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.scope = "everywhere";
		});
		assert.equal(evaluateCall(state, "bash", { command: "cat /etc/passwd" }, space.project).block, false);
	});
});

test("a read-only bash command is allowed", () => {
	withWorkspace((space) => {
		assert.equal(evaluateCall(stateWith(), "bash", { command: "ls -la" }, space.project).block, false);
	});
});

test("the read-only sandbox blocks a write redirect", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.sandboxes.readonly_bash = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "echo hi > f" }, space.project));
		assert.ok(reason.includes("read-only sandbox is on"));
		assert.ok(reason.includes("redirects output"));
	});
});

test("a write redirect is allowed when write is on and the sandbox is off", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
		});
		assert.equal(evaluateCall(state, "bash", { command: "echo hi > f" }, space.project).block, false);
	});
});

test("a write redirect is blocked by the read-only bash sandbox", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
			current.sandboxes.readonly_bash = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "echo hi > f" }, space.project));
		assert.ok(reason.includes("read-only sandbox is on"));
	});
});

test("a write command is blocked by the read-only sandbox", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.sandboxes.readonly_bash = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "rm -rf build" }, space.project));
		assert.ok(reason.includes("rm can delete files"));
	});
});

test("curl is allowed when the no-network sandbox is off", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
		});
		assert.equal(evaluateCall(state, "bash", { command: "curl https://example.com" }, space.project).block, false);
	});
});

test("curl is blocked when the no-network sandbox is on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
			current.sandboxes.no_network = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "curl https://example.com" }, space.project));
		assert.ok(reason.includes("no-network"));
		assert.ok(reason.includes("curl"));
	});
});

test("a shell separator cannot hide a write command from the sandbox", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.sandboxes.readonly_bash = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "ls && rm -f f" }, space.project));
		assert.ok(reason.includes("rm can delete files"));
	});
});

test("reasons start with Blocked and stay short", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.extra_paths = [space.outside];
		});
		const longPath = join(space.root, "elsewhere", "y".repeat(300));
		const decisions: GateDecision[] = [
			evaluateCall(state, "frobnicate", {}, space.project),
			evaluateCall(state, "read", { path: longPath }, space.project),
			evaluateCall(state, "edit", { path: longPath }, space.project),
		];
		for (const decision of decisions) {
			const reason = reasonOf(decision);
			assert.ok(reason.startsWith("Blocked: "));
			assert.ok(reason.length <= 240, `reason too long: ${reason.length}`);
		}
	});
});

test("an allowed call carries no patch", () => {
	withWorkspace((space) => {
		const decision = evaluateCall(stateWith(), "read", { path: join(space.project, "file.txt") }, space.project);
		assert.deepEqual(decision, { block: false });
	});
});

test("input without a path skips the scope check", () => {
	withWorkspace((space) => {
		assert.equal(evaluateCall(stateWith(), "ls", {}, space.project).block, false);
	});
});

test("bash redirects are not part of the project path scope", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
		});
		assert.equal(evaluateCall(state, "bash", { command: "echo hi 2>/dev/null" }, space.project).block, false);
		assert.equal(evaluateCall(state, "bash", { command: "ls > /dev/null" }, space.project).block, false);
		assert.equal(evaluateCall(state, "bash", { command: "echo hi > /tmp/out" }, space.project).block, false);
	});
});

test("a write path that escapes through a symlink is blocked", () => {
	withWorkspace((space) => {
		symlinkSync(space.outside, join(space.project, "link"), "dir");
		const state = stateWith((current) => {
			current.flags.write = true;
		});
		const existing = join(space.project, "link", "secret.txt");
		const created = join(space.project, "link", "new.txt");
		for (const path of [existing, created]) {
			const reason = reasonOf(evaluateCall(state, "write", { path }, space.project));
			assert.ok(reason.includes("outside the allowed roots"));
		}
		assert.equal(
			evaluateCall(state, "write", { path: join(space.project, "new.txt") }, space.project).block,
			false,
		);
	});
});

test("a path with an @ prefix is normalized before the scope check", () => {
	withWorkspace((space) => {
		const reason = reasonOf(evaluateCall(stateWith(), "read", { path: "@/etc/hostname" }, space.project));
		assert.ok(reason.includes("/etc/hostname"));
		assert.ok(reason.includes("outside the allowed roots"));
		assert.ok(!reason.includes("@/etc/hostname"));

		const everywhere = stateWith((current) => {
			current.scope = "everywhere";
		});
		assert.equal(evaluateCall(everywhere, "read", { path: "@/etc/hostname" }, space.project).block, false);
	});
});

test("an unknown MCP tool is blocked with every flag on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags = { read: true, write: true, execute: true };
			current.scope = "everywhere";
			current.sandboxes = { readonly_bash: false, no_network: false };
		});
		const decision = evaluateCall(state, "mcp__foo__bar", {}, space.project);
		assert.equal(decision.block, true);
		if (!decision.block) return;
		assert.equal(decision.kind, "unknown");
		assert.ok(decision.reason.includes("mcp__foo__bar"));
		assert.ok(decision.reason.includes("no toolset"));
	});
});

test("the write flag off blocks write tools but not read-only bash", () => {
	withWorkspace((space) => {
		const state = stateWith();
		for (const toolName of ["edit", "write"]) {
			const reason = reasonOf(evaluateCall(state, toolName, { path: join(space.project, "a.txt") }, space.project));
			assert.ok(reason.includes('"write"'));
			assert.ok(reason.includes("set_flag"));
		}
		assert.equal(evaluateCall(state, "bash", { command: "ls" }, space.project).block, false);
		assert.equal(evaluateCall(state, "bash", { command: "ls -la" }, space.project).block, false);
	});
});

test("the execute flag off blocks bash and codemode", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.execute = false;
		});
		for (const call of [
			{ toolName: "bash", input: { command: "ls" } },
			{ toolName: "codemode", input: {} },
		]) {
			const reason = reasonOf(evaluateCall(state, call.toolName, call.input, space.project));
			assert.ok(reason.includes('"execute"'));
		}
	});
});

test("the read flag off blocks the read tools but not write", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.read = false;
			current.flags.write = true;
		});
		for (const toolName of ["read", "grep", "find", "ls"]) {
			const reason = reasonOf(evaluateCall(state, toolName, { path: join(space.project, "a.txt") }, space.project));
			assert.ok(reason.includes('"read"'));
		}
		assert.equal(evaluateCall(state, "write", { path: join(space.project, "a.txt") }, space.project).block, false);
	});
});

test("the read-only bash sandbox blocks touch even with the write flag on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
			current.sandboxes.readonly_bash = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "touch x" }, space.project));
		assert.ok(reason.includes("read-only sandbox is on"));
		assert.ok(reason.includes("touch"));
		assert.equal(evaluateCall(state, "bash", { command: "ls" }, space.project).block, false);
	});
});

test("the no-network sandbox blocks git fetch but not git status", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
			current.sandboxes.no_network = true;
		});
		const reason = reasonOf(evaluateCall(state, "bash", { command: "git fetch" }, space.project));
		assert.ok(reason.includes("no-network"));
		assert.ok(reason.includes("git fetch"));
		assert.equal(evaluateCall(state, "bash", { command: "git status" }, space.project).block, false);
	});
});

test("an execute tool with another command key is still checked by a sandbox", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.scope = "everywhere";
			current.sandboxes.readonly_bash = true;
		});
		assert.equal(evaluateCall(state, "mcp__fs__bash", { cmd: "rm -rf /" }, space.project).block, true);
		assert.equal(evaluateCall(state, "mcp__fs__bash", { cmd: "ls -la" }, space.project).block, false);
	});
});

test("an execute tool without a command key fails closed when a sandbox is on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.sandboxes.readonly_bash = true;
		});
		assert.equal(evaluateCall(state, "mcp__fs__bash", { payload: "x" }, space.project).block, true);
		const unsandboxed = stateWith((current) => {
			current.flags.write = true;
		});
		assert.equal(evaluateCall(unsandboxed, "mcp__fs__bash", { payload: "x" }, space.project).block, false);
		assert.equal(evaluateCall(unsandboxed, "mcp__fs__bash", { cmd: "rm -rf /" }, space.project).block, false);
	});
});

test("a read tool with another path key is checked", () => {
	withWorkspace((space) => {
		const state = stateWith(() => {});
		assert.equal(evaluateCall(state, "mcp__fs__read", { file_path: "/etc/passwd" }, space.project).block, true);
		assert.equal(
			evaluateCall(state, "mcp__fs__read", { file_path: join(space.project, "file.txt") }, space.project).block,
			false,
		);
	});
});

test("the no-network sandbox blocks xargs and find -exec", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.flags.write = true;
			current.sandboxes.no_network = true;
		});
		assert.equal(evaluateCall(state, "bash", { command: "ls | xargs curl http://x" }, space.project).block, true);
		assert.equal(evaluateCall(state, "bash", { command: "find . -exec ssh h ;" }, space.project).block, true);
		assert.equal(evaluateCall(state, "bash", { command: "git status" }, space.project).block, false);
	});
});
