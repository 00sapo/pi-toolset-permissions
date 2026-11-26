import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fixtureTmpdir as tmpdir } from "../tests/helpers/temp.ts";
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
			source = `export const Type = {
 Object: properties => ({type: "object", properties}),
 Union: (anyOf, fields) => ({anyOf, ...fields}),
 Literal: value => ({const: value}),
 Optional: schema => schema,
 Boolean: fields => ({type: "boolean", ...fields}),
 String: fields => ({type: "string", ...fields}),
 Array: (items, fields) => ({type: "array", items, ...fields}),
 Record: () => ({type: "object"}), Unknown: () => ({})
};`;
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
	parameters: any;
}

function harness(space: Workspace, answer: string | undefined): Harness {
	const store = new StateStore(join(space.root, "permissions.json"));
	let tool: { execute: Function; parameters: any } | undefined;
	registerPermissionsTool(
		{ registerTool: (definition: unknown) => { tool = definition as { execute: Function; parameters: any }; } } as never,
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
		parameters: tool.parameters,
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
	// The permissions toolset has no ask state, so the request is decided at once.
	assert.equal(harnessed.store.get().toolsets.find((entry) => entry.name === "permissions")?.enabled, true);
	const asked = evaluateCall(harnessed.store.get(), "permissions", input, space.project);
	assert.deepEqual(asked, { block: false });
});

test("the permissions toolset cannot be set to ask", async (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const harnessed = harness(space, "Allow once");
	const outcome = await harnessed.run({ action: "set_toolset", name: "permissions", mode: "ask" });
	assert.equal(outcome.isError, true);
	assert.match(outcome.text, /only the on and off states/);
	assert.equal(modeOf(harnessed.store, "permissions"), true);
	const off = await harnessed.run({ action: "set_toolset", name: "permissions", mode: "off" });
	assert.equal(off.isError, undefined);
	assert.equal(modeOf(harnessed.store, "permissions"), false);
});

test("a stored ask mode for the permissions toolset loads as on", (t) => {
	const space = workspace();
	t.after(space.cleanup);
	const file = join(space.root, "stored.json");
	writeFileSync(file, JSON.stringify({ version: 2, toolsets: [{ name: "permissions", patterns: ["^permissions$"], enabled: "ask" }] }));
	const store = new StateStore(file);
	assert.equal(store.get().toolsets.find((entry) => entry.name === "permissions")?.enabled, true);
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

test("set_scope applies all modes and preserves saved paths", async t => {
 const space = workspace(); t.after(space.cleanup);
 const h = harness(space, "Allow once");
 await h.run({ action: "add_path", path: space.outside });
 assert.equal(h.store.get().scope, "custom");
 for (const scope of ["project", "everywhere", "custom", "project"] as const) {
  const result = await h.run({ action: "set_scope", scope });
  assert.equal(result.isError, undefined);
  assert.equal(h.store.get().scope, scope);
  assert.deepEqual(h.store.get().extra_paths, [space.outside]);
  assert.equal(evaluateCall(h.store.get(), "read", { path: space.outside }, space.project).block, scope === "project");
 }
 const result = await h.run({ action: "set_scope", scope: "invalid" });
 assert.equal(result.isError, true);
 assert.equal(h.store.get().scope, "project");
});

test("scope refusal and project root operations do not widen access", async t => {
 const space = workspace(); t.after(space.cleanup);
 const h = harness(space, "Block");
 await h.run({ action: "set_scope", scope: "custom" });
 assert.equal(h.store.get().scope, "project");
 const allowed = harness(space, "Allow once");
 await allowed.run({ action: "add_path", path: space.project });
 assert.deepEqual(allowed.store.get().extra_paths, []);
 assert.equal(allowed.questions.length, 0);
 assert.equal((await allowed.run({ action: "remove_path", path: space.project })).isError, true);
 assert.equal(evaluateCall(allowed.store.get(), "read", { path: space.project }, space.project).block, false);
});


test("set_scope schema exposes all three modes", t => {
 const space = workspace(); t.after(space.cleanup);
 const h = harness(space, "Block");
 assert.deepEqual(h.parameters.properties.scope.anyOf.map((entry: any) => entry.const), ["project", "everywhere", "custom"]);
});

test("add_mount asks, names the path and mode, and saves a read-only mount", async () => {
	const space = workspace();
	try {
		const withAnswer = harness(space, "Allow once");
		const added = await withAnswer.run({ action: "add_mount", path: space.outside });
		assert.equal(added.isError, undefined, added.text);
		assert.match(added.text, /Mounted/);
		assert.match(withAnswer.questions[0], new RegExp(`Mount ${space.outside.replaceAll("/", "\\/")} read-only`));
		assert.deepEqual(withAnswer.store.get().sandbox_mounts, [{ path: space.outside, writable: false }]);
		// A writable mount is named as read-write.
		const writable = await withAnswer.run({ action: "add_mount", path: space.root, writable: true });
		assert.equal(writable.isError, undefined, writable.text);
		assert.match(withAnswer.questions[1], /read-write/);
		assert.deepEqual(withAnswer.store.get().sandbox_mounts.at(-1), { path: space.root, writable: true });
	} finally { space.cleanup(); }
});

test("add_mount refuses a refused mount, a missing path, a protected path, and a duplicate", async () => {
	const space = workspace();
	try {
		const refusing = harness(space, "Block");
		assert.match((await refusing.run({ action: "add_mount", path: space.outside })).text, /declined/);
		assert.deepEqual(refusing.store.get().sandbox_mounts, []);
		const allowed = harness(space, "Allow once");
		assert.equal((await allowed.run({ action: "add_mount", path: join(space.root, "missing") })).isError, true);
		assert.equal((await allowed.run({ action: "add_mount", path: "/run/data" })).isError, true);
		assert.equal((await allowed.run({ action: "add_mount" })).isError, true);
		await allowed.run({ action: "add_mount", path: space.outside });
		assert.match((await allowed.run({ action: "add_mount", path: space.outside })).text, /already mounted/);
		assert.equal(allowed.store.get().sandbox_mounts.length, 1);
	} finally { space.cleanup(); }
});

test("remove_mount asks and removes only a mounted path", async () => {
	const space = workspace();
	try {
		const allowed = harness(space, "Allow once");
		await allowed.run({ action: "add_mount", path: space.outside });
		assert.match((await allowed.run({ action: "remove_mount", path: space.outside })).text, /Unmounted/);
		assert.deepEqual(allowed.store.get().sandbox_mounts, []);
		assert.equal((await allowed.run({ action: "remove_mount", path: space.outside })).isError, true);
		await allowed.run({ action: "add_mount", path: space.outside });
		const refusing = harness(space, "Block");
		assert.match((await refusing.run({ action: "remove_mount", path: space.outside })).text, /declined/);
	} finally { space.cleanup(); }
});

test("save_defaults asks, writes the template, and leaves the session state alone", async () => {
	const space = workspace();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = space.root;
	try {
		const allowed = harness(space, "Allow once");
		await allowed.run({ action: "set_scope", scope: "custom" });
		const before = allowed.store.get();
		const saved = await allowed.run({ action: "save_defaults" });
		assert.equal(saved.isError, undefined, saved.text);
		assert.match(saved.text, /The next session starts from these settings/);
		assert.deepEqual(allowed.store.get(), before, "the session keeps its own state");
		// The template file holds the session values.
		const template = new StateStore(join(space.root, "permissions.json")).get();
		assert.equal(template.scope, "custom");
		const refusing = harness(space, "Block");
		assert.match((await refusing.run({ action: "save_defaults" })).text, /declined/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		space.cleanup();
	}
});

test("add_path refuses a whole private tree before the dialog", async () => {
	const space = workspace();
	try {
		const harnessed = harness(space, "Allow once");
		for (const path of ["/run", "/etc", "/"]) {
			const outcome = await harnessed.run({ action: "add_path", path });
			assert.equal(outcome.isError, true, path);
			assert.match(outcome.text, /belongs to the sandbox itself/);
		}
		assert.equal(harnessed.questions.length, 0, "no dialog is needed for a path that cannot work");
		assert.deepEqual(harnessed.store.get().extra_paths, []);
		// An ordinary directory still works, so the refusal is not a blanket block.
		assert.equal((await harnessed.run({ action: "add_path", path: space.outside })).isError, undefined);
	} finally { space.cleanup(); }
});
