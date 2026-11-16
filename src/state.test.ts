import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore, defaultState, loadState, mergeState, saveState, statePath } from "./state.ts";
import type { PermissionsState } from "./types.ts";

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-perm-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withTempDir(run: (dir: string) => void): void {
	const { dir, cleanup } = tempDir();
	try {
		run(dir);
	} finally {
		cleanup();
	}
}

test("defaults match the sketch", () => {
	const state = defaultState();
	assert.equal(state.version, 1);
	assert.deepEqual(state.flags, { read: true, write: false, execute: true });
	assert.equal(state.scope, "project");
	assert.deepEqual(state.extra_paths, []);
	assert.deepEqual(state.sandboxes, { readonly_bash: false, no_network: false });
	assert.deepEqual(
		state.toolsets.map((toolset) => [toolset.name, toolset.risk, toolset.builtin, toolset.enabled]),
		[
			["read", "read", true, true],
			["write", "write", true, true],
			["execute", "execute", true, true],
		],
	);
});

test("defaultState returns fresh objects", () => {
	const first = defaultState();
	first.flags.write = true;
	first.toolsets[0].patterns.length = 0;
	const second = defaultState();
	assert.equal(second.flags.write, false);
	assert.ok(second.toolsets[0].patterns.length > 0);
});

test("mergeState repairs garbage", () => {
	const state = mergeState({
		version: 99,
		flags: { read: "yes", write: null, execute: 0 },
		scope: "galaxy",
		extra_paths: ["relative/dir", 42, "/abs/one", "/abs/one"],
		sandboxes: { readonly_bash: "true", no_network: 1 },
		toolsets: "nope",
	});
	assert.equal(state.version, 1);
	assert.deepEqual(state.flags, { read: true, write: false, execute: true });
	assert.equal(state.scope, "project");
	assert.deepEqual(state.extra_paths, ["/abs/one"]);
	assert.deepEqual(state.sandboxes, { readonly_bash: false, no_network: false });
	assert.equal(state.toolsets.length, 3);
});

test("mergeState keeps valid recognized fields", () => {
	const state = mergeState({
		flags: { read: false, write: true, execute: false },
		scope: "everywhere",
		extra_paths: ["/tmp/work"],
		sandboxes: { readonly_bash: true, no_network: true },
	});
	assert.deepEqual(state.flags, { read: false, write: true, execute: false });
	assert.equal(state.scope, "everywhere");
	assert.deepEqual(state.extra_paths, ["/tmp/work"]);
	assert.deepEqual(state.sandboxes, { readonly_bash: true, no_network: true });
});

test("mergeState drops a toolset with an invalid regex", () => {
	const state = mergeState({
		toolsets: [
			{ name: "bad", risk: "read", patterns: ["["], enabled: true },
			{ name: "good", risk: "read", patterns: ["^good$"], enabled: true },
		],
	});
	assert.deepEqual(
		state.toolsets.map((toolset) => toolset.name),
		["read", "write", "execute", "good"],
	);
});

test("mergeState drops custom toolsets with bad fields", () => {
	const state = mergeState({
		toolsets: [
			{ name: "", risk: "read", patterns: ["^a$"] },
			{ name: "bad-risk", risk: "admin", patterns: ["^a$"] },
			{ name: "no-patterns", risk: "read", patterns: [] },
			{ name: "not-strings", risk: "read", patterns: [1, 2] },
			"nope",
		],
	});
	assert.equal(state.toolsets.length, 3);
});

test("mergeState drops duplicate toolset names", () => {
	const state = mergeState({
		toolsets: [
			{ name: "dup", risk: "read", patterns: ["^dup$"], enabled: true },
			{ name: "dup", risk: "execute", patterns: ["^dup$"], enabled: true },
		],
	});
	const names = state.toolsets.map((toolset) => toolset.name);
	assert.equal(names.filter((name) => name === "dup").length, 1);
});

test("mergeState restores the builtin toolsets", () => {
	const state = mergeState({
		toolsets: [
			{ name: "read", risk: "execute", patterns: ["^evil$"], enabled: false, builtin: true },
			{ name: "write", risk: "read", patterns: ["^evil$"], enabled: false, builtin: false },
		],
	});
	const byName = new Map(state.toolsets.map((toolset) => [toolset.name, toolset]));
	assert.equal(state.toolsets.length, 3);
	const read = byName.get("read");
	assert.ok(read);
	assert.equal(read.risk, "read");
	assert.equal(read.builtin, true);
	assert.equal(read.enabled, true);
	assert.ok(read.patterns.includes("^(read|ls|find|grep|tool_search)$"));
	assert.equal(byName.get("write")?.risk, "write");
	assert.equal(byName.get("execute")?.builtin, true);
});

test("mergeState defaults a custom toolset to enabled", () => {
	const state = mergeState({ toolsets: [{ name: "custom", risk: "write", patterns: ["^custom$"] }] });
	const custom = state.toolsets.find((toolset) => toolset.name === "custom");
	assert.ok(custom);
	assert.equal(custom.enabled, true);
	assert.equal(custom.builtin, false);
});

test("mergeState restores the builtins after disable, reclassify, or rename attempts", () => {
	const state = mergeState({
		toolsets: [
			{ name: "read", risk: "execute", patterns: ["^evil$"], enabled: false, builtin: true },
			{ name: "write", risk: "read", patterns: ["^evil$"], enabled: false, builtin: true },
			{ name: "execute", risk: "write", patterns: ["^evil$"], enabled: false, builtin: true },
			{ name: "read-all", risk: "execute", patterns: ["^evil$"], enabled: false, builtin: true },
		],
	});
	const defaults = defaultState().toolsets;
	assert.deepEqual(
		state.toolsets.slice(0, 3).map((toolset) => toolset.name),
		["read", "write", "execute"],
	);
	for (const [index, toolset] of state.toolsets.slice(0, 3).entries()) {
		const expected = defaults[index];
		assert.ok(expected);
		assert.equal(toolset.risk, expected.risk);
		assert.equal(toolset.builtin, true);
		assert.equal(toolset.enabled, true);
		assert.deepEqual(toolset.patterns, expected.patterns);
	}
	const renamed = state.toolsets.find((toolset) => toolset.name === "read-all");
	assert.ok(renamed, "a renamed builtin entry stays as an ordinary custom toolset");
	assert.equal(renamed.builtin, false);
	assert.equal(renamed.enabled, false);
	assert.equal(renamed.risk, "execute");
});

test("mergeState accepts junk input", () => {
	for (const raw of [null, undefined, 42, "junk", [], { flags: [] }, { extra_paths: {} }]) {
		const state = mergeState(raw);
		assert.equal(state.version, 1);
		assert.equal(state.scope, "project");
		assert.equal(state.toolsets.length, 3);
	}
});

test("loadState returns defaults for a missing file", () => {
	withTempDir((dir) => {
		const state = loadState(join(dir, "missing.json"));
		assert.deepEqual(state, defaultState());
	});
});

test("loadState returns defaults for unparseable JSON", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		writeFileSync(file, "{not json");
		assert.deepEqual(loadState(file), defaultState());
	});
});

test("saveState and loadState round trip", () => {
	withTempDir((dir) => {
		const file = join(dir, "nested", "permissions.json");
		const state: PermissionsState = defaultState();
		state.flags.write = true;
		state.scope = "everywhere";
		state.extra_paths = ["/tmp/work"];
		state.sandboxes.no_network = true;
		state.toolsets.push({
			name: "custom",
			risk: "write",
			patterns: ["^custom_"],
			enabled: false,
			builtin: false,
		});

		saveState(state, file);
		assert.deepEqual(loadState(file), state);
		assert.deepEqual(readdirSync(join(dir, "nested")), ["permissions.json"]);
	});
});

test("saveState is atomic and leaves no temp file", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		saveState(defaultState(), file);
		saveState(defaultState(), file);
		assert.deepEqual(readdirSync(dir), ["permissions.json"]);
	});
});

test("statePath honors PI_PERMISSIONS_FILE", () => {
	const previous = process.env.PI_PERMISSIONS_FILE;
	try {
		process.env.PI_PERMISSIONS_FILE = "/tmp/custom-permissions.json";
		assert.equal(statePath(), "/tmp/custom-permissions.json");
	} finally {
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
	}
});

test("statePath falls back to the coding agent directory", () => {
	const previousFile = process.env.PI_PERMISSIONS_FILE;
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_PERMISSIONS_FILE;
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
		assert.equal(statePath(), "/tmp/agent-dir/permissions.json");
	} finally {
		if (previousFile !== undefined) process.env.PI_PERMISSIONS_FILE = previousFile;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
});

test("StateStore saves on update and notifies listeners", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const store = new StateStore(file);
		const seen: PermissionsState[] = [];
		store.onChange((state) => seen.push(state));

		const next = store.update((current) => ({ ...current, flags: { ...current.flags, write: true } }));
		assert.equal(next.flags.write, true);
		assert.equal(store.get().flags.write, true);
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], store.get());
		assert.equal(loadState(file).flags.write, true);
	});
});

test("StateStore repairs invalid updates", () => {
	withTempDir((dir) => {
		const store = new StateStore(join(dir, "permissions.json"));
		const next = store.update((current) => ({ ...current, scope: "bogus" as unknown as "project" }));
		assert.equal(next.scope, "project");
	});
});

test("StateStore reload reads the file again", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const store = new StateStore(file);
		const other = defaultState();
		other.scope = "everywhere";
		saveState(other, file);
		assert.equal(store.get().scope, "project");
		assert.equal(store.reload().scope, "everywhere");
	});
});

test("StateStore.update persists and a second store sees the change", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const first = new StateStore(file);
		first.update((current) => ({ ...current, flags: { ...current.flags, write: true }, scope: "everywhere" }));

		const second = new StateStore(file);
		assert.equal(second.get().flags.write, true);
		assert.equal(second.get().scope, "everywhere");
		assert.deepEqual(second.get(), first.get());
	});
});

test("a failed save leaves the in-memory state unchanged", () => {
	withTempDir((dir) => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const file = join(blocker, "permissions.json");

		const store = new StateStore(file);
		const before = store.get();
		let notified = 0;
		store.onChange(() => {
			notified += 1;
		});

		assert.throws(() => {
			store.update((current) => ({ ...current, flags: { ...current.flags, write: true } }));
		});
		assert.equal(notified, 0);
		assert.equal(store.get(), before);
		assert.deepEqual(store.get().flags, { read: true, write: false, execute: true });
	});
});

test("update rebases on the file so two stores keep both changes", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const first = new StateStore(file);
		const second = new StateStore(file);
		first.update((state) => ({ ...state, extra_paths: ["/tmp/one"] }));
		second.update((state) => ({ ...state, flags: { ...state.flags, write: true } }));
		const reloaded = new StateStore(file);
		assert.deepEqual(reloaded.get().extra_paths, ["/tmp/one"]);
		assert.equal(reloaded.get().flags.write, true);
	});
});
