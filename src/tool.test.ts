import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Approvals } from "./approval.ts";
import { evaluateCall } from "./gate.ts";
import { StateStore } from "./state.ts";
import type { PermissionsState } from "./types.ts";

// The host and typebox are not installed here. Give typebox a permissive runtime
// schema and keep the real permissions tool code under test.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		let source: string | undefined;
		if (specifier === "typebox") {
			source = "const make = () => ({}); export const Type = new Proxy({}, { get: () => make });";
		} else if (specifier === "@earendil-works/pi-coding-agent") {
			source = "export const noop = undefined;";
		}
		if (source !== undefined) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { registerPermissionsTool } = await import("./tool.ts");
hooks.deregister();

interface Workspace {
	root: string;
	project: string;
	outside: string;
	cleanup: () => void;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "pi-add-path-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	return { root, project, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Outcome = { text: string; isError?: boolean };

interface Harness {
	store: StateStore;
	run: (params: Record<string, unknown>) => Promise<Outcome>;
	questions: string[];
}

function harness(space: Workspace, answer: string | undefined): Harness {
	const store = new StateStore(join(space.root, "permissions.json"));
	let tool: { execute: Function } | undefined;
	registerPermissionsTool(
		{ registerTool: (definition: unknown) => { tool = definition as { execute: Function }; } } as never,
		store,
		() => {},
		new Approvals(),
	);
	assert.ok(tool);
	const questions: string[] = [];
	const ctx = {
		cwd: space.project,
		hasUI: true,
		ui: {
			select: async (title: string) => {
				questions.push(title);
				return answer;
			},
			confirm: async (title: string) => {
				questions.push(title);
				return answer === "Allow once";
			},
		},
	};
	return {
		store,
		run: async (params) => {
			const result = (await tool!.execute("call-1", params, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
				isError?: boolean;
			};
			return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError };
		},
		questions,
	};
}

function setMode(store: StateStore, name: string, enabled: boolean | "ask"): void {
	store.update((state: PermissionsState) => ({
		...state,
		toolsets: state.toolsets.map((entry) => (entry.name === name ? { ...entry, enabled } : entry)),
	}));
}

function modeOf(store: StateStore, name: string): boolean | "ask" | undefined {
	return store.get().toolsets.find((entry) => entry.name === name)?.enabled;
}

test("add_path for an outside directory is decided by the toolset, not by the file scope", (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	const input = { action: "add_path", path: space.outside };
	// Before the fix the gate read the directory as a target file path and blocked it.
	assert.deepEqual(evaluateCall(harnessed.store.get(), "permissions", input, space.project), { block: false });
	assert.deepEqual(harnessed.store.get().extra_paths, []);
	// In ask mode the request waits for approval instead of a scope block.
	setMode(harnessed.store, "permissions", "ask");
	const asked = evaluateCall(harnessed.store.get(), "permissions", input, space.project);
	assert.equal(asked.block, true);
	if (asked.block) assert.equal(asked.kind, "ask");
});

test("approval adds the requested directory and keeps the toolset modes", async (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	const input = { action: "add_path", path: space.outside };
	assert.equal(evaluateCall(harnessed.store.get(), "permissions", input, space.project).block, false);

	// The tool asks its own question, then saves the canonical path.
	const outcome = await harnessed.run(input);
	assert.equal(outcome.isError, undefined);
	assert.match(outcome.text, /Added .*outside to the allowed paths/);
	assert.equal(harnessed.questions.length, 1);
	assert.match(harnessed.questions[0], /Allow this directory/);
	assert.deepEqual(harnessed.store.get().extra_paths, [space.outside]);
	assert.equal(modeOf(harnessed.store, "permissions"), true);
	// The new path now passes the ordinary file scope check.
	assert.equal(evaluateCall(harnessed.store.get(), "read", { path: join(space.outside, "file.txt") }, space.project).block, false);
});

test("refusal leaves the allowed paths unchanged", async (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Block");
	const outcome = await harnessed.run({ action: "add_path", path: space.outside });
	assert.equal(outcome.isError, undefined);
	assert.match(outcome.text, /declined the change/);
	assert.equal(harnessed.questions.length, 1);
	assert.deepEqual(harnessed.store.get().extra_paths, []);
	assert.equal(evaluateCall(harnessed.store.get(), "read", { path: join(space.outside, "file.txt") }, space.project).block, true);
});

test("a missing directory is refused before the dialog", async (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	const outcome = await harnessed.run({ action: "add_path", path: join(space.outside, "missing") });
	assert.equal(outcome.isError, true);
	assert.match(outcome.text, /does not exist/);
	assert.equal(harnessed.questions.length, 0);
	assert.deepEqual(harnessed.store.get().extra_paths, []);
});

test("the off permissions toolset cannot change the state", async (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	setMode(harnessed.store, "permissions", false);
	const input = { action: "add_path", path: space.outside };
	const decision = evaluateCall(harnessed.store.get(), "permissions", input, space.project);
	assert.equal(decision.block, true);
	if (decision.block) assert.equal(decision.kind, "disabled");
	assert.deepEqual(harnessed.store.get().extra_paths, []);
});

test("an ordinary file call outside the allowed roots stays blocked", (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	setMode(harnessed.store, "read", true);
	const decision = evaluateCall(harnessed.store.get(), "read", { path: join(space.outside, "file.txt") }, space.project);
	assert.equal(decision.block, true);
	if (decision.block) assert.equal(decision.kind, "scope");
	// Another tool cannot borrow the permission-management exemption.
	assert.equal(evaluateCall(harnessed.store.get(), "write", { action: "add_path", path: space.outside }, space.project).block, true);
});
