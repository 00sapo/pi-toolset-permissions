import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateCall } from "./gate.ts";
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

function setToolset(state: PermissionsState, name: string, enabled: boolean): void {
	for (const toolset of state.toolsets) {
		if (toolset.name === name) toolset.enabled = enabled;
	}
}

function reasonOf(decision: GateDecision): string {
	assert.equal(decision.block, true, "expected the call to be blocked");
	if (!decision.block) return "";
	return decision.reason;
}

test("the permission toolset is a normal builtin toolset", () => {
	withWorkspace((space) => {
		const state = stateWith();
		const toolset = state.toolsets.find((entry) => entry.name === "permission");
		assert.ok(toolset);
		assert.equal(toolset.builtin, true);
		assert.equal(toolset.enabled, true);
		assert.deepEqual(toolset.patterns, ["^permissions$"]);
		assert.equal(evaluateCall(state, "permissions", {}, space.project).block, false);
	});
});

test("the permissions tool is blocked when the permission toolset is off", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			for (const toolset of current.toolsets) toolset.enabled = false;
		});
		const reason = reasonOf(evaluateCall(state, "permissions", {}, space.project));
		assert.ok(reason.includes("no toolset"));
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

test("the default state blocks write tools because the write toolset is off", () => {
	withWorkspace((space) => {
		const state = stateWith();
		for (const toolName of ["write", "edit"]) {
			const reason = reasonOf(evaluateCall(state, toolName, { path: join(space.project, "a.txt") }, space.project));
			assert.ok(reason.includes("no toolset"));
			assert.ok(reason.includes(`"${toolName}"`));
		}
	});
});

test("the write toolset allows write tools when it is on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => setToolset(current, "write", true));
		const decision = evaluateCall(state, "write", { path: join(space.project, "new.txt") }, space.project);
		assert.equal(decision.block, false);
	});
});

test("the execute toolset off blocks bash and codemode", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => setToolset(current, "execute", false));
		for (const call of [
			{ toolName: "bash", input: { command: "ls" } },
			{ toolName: "codemode", input: {} },
		]) {
			const reason = reasonOf(evaluateCall(state, call.toolName, call.input, space.project));
			assert.ok(reason.includes("no toolset"));
		}
	});
});

test("the read toolset off blocks the read tools but not bash", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => setToolset(current, "read", false));
		for (const toolName of ["read", "grep", "find", "ls"]) {
			const reason = reasonOf(evaluateCall(state, toolName, { path: join(space.project, "a.txt") }, space.project));
			assert.ok(reason.includes("no toolset"));
		}
		assert.equal(evaluateCall(state, "bash", { command: "ls" }, space.project).block, false);
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
		assert.equal(evaluateCall(stateWith(), "bash", { command: "echo hi 2>/dev/null" }, space.project).block, false);
		assert.equal(evaluateCall(stateWith(), "bash", { command: "ls > /dev/null" }, space.project).block, false);
		assert.equal(evaluateCall(stateWith(), "bash", { command: "echo hi > /tmp/out" }, space.project).block, false);
	});
});

test("a write path that escapes through a symlink is blocked", () => {
	withWorkspace((space) => {
		symlinkSync(space.outside, join(space.project, "link"), "dir");
		const state = stateWith((current) => setToolset(current, "write", true));
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

test("a matched tool with another path key is checked", () => {
	withWorkspace((space) => {
		const state = stateWith((current) =>
			current.toolsets.push({
				name: "fs",
				patterns: ["^mcp__fs__"],
				enabled: true,
				builtin: false,
			}),
		);
		assert.equal(evaluateCall(state, "mcp__fs__read", { file_path: "/etc/passwd" }, space.project).block, true);
		assert.equal(
			evaluateCall(state, "mcp__fs__read", { file_path: join(space.project, "file.txt") }, space.project).block,
			false,
		);
	});
});

test("an unknown MCP tool is blocked", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.scope = "everywhere";
		});
		const decision = evaluateCall(state, "mcp__foo__bar", {}, space.project);
		assert.equal(decision.block, true);
		if (!decision.block) return;
		assert.equal(decision.kind, "unknown");
		assert.ok(decision.reason.includes("mcp__foo__bar"));
		assert.ok(decision.reason.includes("no toolset"));
	});
});

test("a custom toolset lets an MCP tool through", () => {
	withWorkspace((space) => {
		const state = stateWith((current) =>
			current.toolsets.push({
				name: "mcp-foo",
				patterns: ["^mcp__foo_"],
				enabled: true,
				builtin: false,
			}),
		);
		assert.equal(evaluateCall(state, "mcp__foo__bar", {}, space.project).block, false);
	});
});

test("the gate does not inspect bash commands when a sandbox is on", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.sandboxes = { readonly_bash: true, no_network: true };
		});
		assert.equal(evaluateCall(state, "bash", { command: "ls | xargs curl http://x" }, space.project).block, false);
		assert.equal(evaluateCall(state, "bash", { command: "rm -rf /" }, space.project).block, false);
	});
});
