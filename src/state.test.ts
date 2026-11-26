import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MAX_MOUNTS,
	MAX_TOOLSETS,
	MAX_TOOLSET_PATTERNS,
	StateStore,
	checkPatterns,
	defaultState,
	loadState,
	mergeState,
	saveState,
	statePath,
} from "./state.ts";
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
	assert.deepEqual(state.unsandboxed_tools, ["^subagents_enable$"]);
	assert.equal(state.version, 4);
	assert.equal(state.scope, "project");
	assert.deepEqual(state.extra_paths, []);
	assert.deepEqual(state.sandboxes, { filesystem: "off", no_network: false });
	assert.deepEqual(
		state.toolsets.map((toolset) => [toolset.name, toolset.enabled, toolset.builtin]),
		[
			["read", true, true],
			["write", true, true],
			["execute", true, true],
			["subagent", true, true],
			["permissions", true, true],
		],
	);
});

test("defaultState returns fresh objects", () => {
	const first = defaultState();
	first.toolsets[0]?.patterns.push("^extra$");
	first.extra_paths.push("/tmp/x");
	const second = defaultState();
	assert.ok(!second.toolsets[0]?.patterns.includes("^extra$"));
	assert.deepEqual(second.extra_paths, []);
});

test("mergeState repairs garbage", () => {
	const state = mergeState({
		version: 99,
		flags: { read: "yes" },
		scope: "galaxy",
		extra_paths: ["relative/dir", 42, "/abs/one", "/abs/one"],
		sandboxes: { readonly_bash: "true", no_network: 1 },
		toolsets: "nope",
	});
	assert.equal(state.version, 4);
	assert.equal(state.scope, "project");
	assert.deepEqual(state.extra_paths, ["/abs/one"]);
	assert.deepEqual(state.sandboxes, { filesystem: "off", no_network: false });
	assert.deepEqual(state.sandbox_mounts, []);
	assert.equal(state.toolsets.length, 5);
});

test("mergeState keeps valid recognized fields", () => {
	const state = mergeState({
		scope: "everywhere",
		extra_paths: ["/tmp/work"],
		sandboxes: { readonly_bash: true, no_network: true },
	});
	assert.equal(state.scope, "everywhere");
	assert.deepEqual(state.extra_paths, ["/tmp/work"]);
	assert.deepEqual(state.sandboxes, { filesystem: "off", no_network: true });
});

test("mergeState drops a toolset with an invalid regex", () => {
	const state = mergeState({
		toolsets: [
			{ name: "bad", patterns: ["["], enabled: true },
			{ name: "good", patterns: ["^good$"], enabled: true },
		],
	});
	assert.deepEqual(
		state.toolsets.map((toolset) => toolset.name),
		["read", "write", "execute", "subagent", "permissions", "good"],
	);
});

test("mergeState drops custom toolsets with bad fields", () => {
	const state = mergeState({
		toolsets: [
			{ name: "", patterns: ["^a$"] },
			{ name: "no-patterns", patterns: [] },
			{ name: "not-strings", patterns: [1, 2] },
			"nope",
		],
	});
	assert.equal(state.toolsets.length, 5);
});

test("mergeState drops duplicate toolset names", () => {
	const state = mergeState({
		toolsets: [
			{ name: "dup", patterns: ["^dup$"], enabled: true },
			{ name: "dup", patterns: ["^dup$"], enabled: false },
		],
	});
	const names = state.toolsets.map((toolset) => toolset.name);
	assert.equal(names.filter((name) => name === "dup").length, 1);
});

test("mergeState takes a pattern edit for a shipped toolset", () => {
	const state = mergeState({
		toolsets: [{ name: "read", patterns: ["^read$", "^cat_"], enabled: true, builtin: true }],
	});
	const read = state.toolsets.find((toolset) => toolset.name === "read");
	assert.ok(read);
	assert.equal(read.builtin, true);
	assert.equal(read.enabled, true);
	assert.deepEqual(read.patterns, ["^read$", "^cat_"]);
});

test("mergeState keeps the shipped patterns when a stored pattern list is invalid", () => {
	const defaults = defaultState().toolsets.find((toolset) => toolset.name === "read");
	const state = mergeState({
		toolsets: [
			{ name: "read", patterns: ["["], enabled: false },
			{ name: "execute", patterns: [], enabled: false },
		],
	});
	const read = state.toolsets.find((toolset) => toolset.name === "read");
	const execute = state.toolsets.find((toolset) => toolset.name === "execute");
	assert.ok(read && defaults);
	assert.deepEqual(read.patterns, defaults.patterns);
	assert.equal(read.enabled, true);
	assert.ok(execute);
	assert.equal(execute.enabled, true);
});

test("mergeState keeps a shipped toolset toggle", () => {
	const state = mergeState({
		toolsets: [
			{ name: "read", patterns: ["^evil$"], enabled: false },
			{ name: "write", patterns: ["^evil$"], enabled: true },
		],
	});
	const byName = new Map(state.toolsets.map((toolset) => [toolset.name, toolset]));
	assert.equal(byName.get("read")?.enabled, false);
	assert.equal(byName.get("write")?.enabled, true);
});

test("mergeState lets the file turn the permissions toolset off", () => {
	const state = mergeState({
		toolsets: [{ name: "permissions", patterns: ["^nothing$"], enabled: false, builtin: true }],
	});
	const permission = state.toolsets.find((toolset) => toolset.name === "permissions");
	assert.ok(permission);
	assert.equal(permission.enabled, false);
	assert.deepEqual(permission.patterns, ["^nothing$"]);
});

for (const enabled of [false, true] as const) {
	test(`mergeState migrates legacy permission with mode ${enabled} and edited patterns`, () => {
		const patterns = ["^permissions$", "^legacy_permission_action$"];
		const state = mergeState({
			toolsets: [{ name: "permission", patterns, enabled, builtin: true }],
		});
		assert.deepEqual(state.toolsets.find((toolset) => toolset.name === "permissions"), {
			name: "permissions", patterns, enabled, builtin: true,
		});
		assert.equal(state.toolsets.some((toolset) => toolset.name === "permission"), false);
		assert.equal(state.toolsets.filter((toolset) => toolset.name === "permissions").length, 1);
		assert.equal(state.toolsets.length, 5);
	});
}

for (const legacyFirst of [false, true]) {
	test(`mergeState prefers canonical permissions with legacyFirst=${legacyFirst}`, () => {
		const canonical = { name: "permissions", patterns: ["^canonical$"], enabled: true, builtin: true };
		const legacy = { name: "permission", patterns: ["^legacy$"], enabled: false, builtin: true };
		const state = mergeState({ toolsets: legacyFirst ? [legacy, canonical] : [canonical, legacy] });
		assert.deepEqual(state.toolsets.find((toolset) => toolset.name === "permissions"), canonical);
		assert.equal(state.toolsets.some((toolset) => toolset.name === "permission"), false);
		assert.equal(state.toolsets.filter((toolset) => toolset.name === "permissions").length, 1);
		assert.equal(state.toolsets.length, 5);
	});
}

test("mergeState defaults a custom toolset to enabled", () => {
	const state = mergeState({ toolsets: [{ name: "custom", patterns: ["^custom$"] }] });
	const custom = state.toolsets.find((toolset) => toolset.name === "custom");
	assert.ok(custom);
	assert.equal(custom.enabled, true);
	assert.equal(custom.builtin, false);
});

test("mergeState caps the toolset list", () => {
	const toolsets = Array.from({ length: MAX_TOOLSETS + 10 }, (_, position) => ({
		name: `custom-${position}`,
		patterns: ["^custom$"],
	}));
	assert.equal(mergeState({ toolsets }).toolsets.length, MAX_TOOLSETS);
});

test("mergeState accepts junk input", () => {
	for (const raw of [null, undefined, 42, "junk", [], { flags: [] }, { extra_paths: {} }]) {
		const state = mergeState(raw);
		assert.equal(state.version, 4);
		assert.equal(state.scope, "project");
		assert.equal(state.toolsets.length, 5);
	}
});

test("checkPatterns trims each entry", () => {
	assert.deepEqual(checkPatterns([" ^a$ ", "^b$"]), { patterns: ["^a$", "^b$"] });
});

test("checkPatterns reports the first bad entry", () => {
	for (const raw of [[], ["["], [""], [42], ["x".repeat(501)]] as unknown[][]) {
		const checked = checkPatterns(raw);
		assert.ok("error" in checked, `expected an error for ${JSON.stringify(raw)}`);
	}
});

test("checkPatterns caps the list", () => {
	const many = Array.from({ length: MAX_TOOLSET_PATTERNS + 8 }, (_, position) => `^tool${position}$`);
	const checked = checkPatterns(many);
	assert.ok("patterns" in checked);
	assert.equal(checked.patterns.length, MAX_TOOLSET_PATTERNS);
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
		state.scope = "everywhere";
		state.extra_paths = ["/tmp/work"];
		state.sandboxes.no_network = true;
		for (const toolset of state.toolsets) {
			if (toolset.name === "write") toolset.enabled = true;
		}
		state.toolsets.push({
			name: "custom",
			patterns: ["^custom_"],
			enabled: false,
			builtin: false,
		});
		state.unsandboxed_tools = ["^my_host_tool$"];

		saveState(state, file);
		assert.deepEqual(loadState(file), state);
		assert.deepEqual(readdirSync(join(dir, "nested")), ["permissions.json"]);
	});
});

test("saveState and loadState keep a pattern edit of a shipped toolset", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const state = defaultState();
		const read = state.toolsets.find((toolset) => toolset.name === "read");
		assert.ok(read);
		read.patterns = ["^read$", "^cat_"];
		saveState(state, file);
		const loaded = loadState(file);
		const stored = loaded.toolsets.find((toolset) => toolset.name === "read");
		assert.ok(stored);
		assert.equal(stored.builtin, true);
		assert.deepEqual(stored.patterns, ["^read$", "^cat_"]);
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

		const next = store.update((current) => ({ ...current, scope: "everywhere" }));
		assert.equal(next.scope, "everywhere");
		assert.equal(store.get().scope, "everywhere");
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], store.get());
		assert.equal(loadState(file).scope, "everywhere");
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
		first.update((current) => ({ ...current, scope: "everywhere" }));

		const second = new StateStore(file);
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
			store.update((current) => ({ ...current, scope: "everywhere" }));
		});
		assert.equal(notified, 0);
		assert.equal(store.get(), before);
		assert.equal(store.get().scope, "project");
	});
});

test("update rebases on the file so two stores keep both changes", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const first = new StateStore(file);
		const second = new StateStore(file);
		first.update((state) => ({ ...state, extra_paths: ["/tmp/one"] }));
		second.update((state) => ({ ...state, scope: "everywhere" }));
		const reloaded = new StateStore(file);
		assert.deepEqual(reloaded.get().extra_paths, ["/tmp/one"]);
		assert.equal(reloaded.get().scope, "everywhere");
	});
});

test("version 4 persists all three modes for builtin and custom toolsets", () => {
	withTempDir((dir) => {
		const file = join(dir, "permissions.json");
		const state = defaultState();
		state.toolsets[0].enabled = "ask";
		for (const enabled of [false, true, "ask"] as const) {
			state.toolsets.push({ name: `custom-${enabled}`, enabled, patterns: ["^custom$"], builtin: false });
		}
		saveState(state, file);
		assert.deepEqual(loadState(file), state);
		const store = new StateStore(file);
		assert.equal(store.update((current) => current).toolsets[0].enabled, "ask");
		assert.equal(loadState(file).version, 4);
	});
});

test("version 2 boolean states retain their modes", () => {
	const state = defaultState();
	assert.deepEqual(mergeState(JSON.parse(JSON.stringify(state))), state);
});

for (const filesystem of ["off", "read", "read+write"] as const) {
 test(`filesystem ${filesystem} survives project normalization`, () => {
  assert.equal(mergeState({ sandboxes: { filesystem } }).sandboxes.filesystem, filesystem);
 });
 test(`everywhere coerces filesystem ${filesystem} off`, () => {
  assert.equal(mergeState({ scope: "everywhere", sandboxes: { filesystem } }).sandboxes.filesystem, "off");
 });
}
test("legacy readonly migration only applies when filesystem is absent", () => {
 assert.equal(mergeState({ sandboxes: { readonly_bash: true } }).sandboxes.filesystem, "read");
 assert.equal(mergeState({ sandboxes: { readonly_bash: false } }).sandboxes.filesystem, "off");
 for (const filesystem of ["off", "read", "read+write"]) {
  assert.equal(mergeState({ sandboxes: { filesystem, readonly_bash: true } }).sandboxes.filesystem, filesystem);
 }
 // An unknown value must never fall back to the unrestricted state.
 for (const filesystem of ["invalid", "Read", "readonly", false, null]) {
  assert.equal(mergeState({ sandboxes: { filesystem, readonly_bash: false } }).sandboxes.filesystem, "read", String(filesystem));
 }
 assert.equal(mergeState({ scope: "everywhere", sandboxes: { readonly_bash: true } }).sandboxes.filesystem, "off");
});
test("store updates and loads reset filesystem for everywhere scope", () => {
 withTempDir((dir) => {
  const file = join(dir, "permissions.json");
  const store = new StateStore(file);
  store.update((state) => ({ ...state, sandboxes: { filesystem: "read+write", no_network: true } }));
  assert.equal(store.update((state) => ({ ...state, scope: "everywhere" })).sandboxes.filesystem, "off");
  assert.equal(store.update((state) => ({ ...state, sandboxes: { ...state.sandboxes, filesystem: "read" } })).sandboxes.filesystem, "off");
  assert.equal(store.get().sandboxes.no_network, true);
  writeFileSync(file, JSON.stringify({ scope: "everywhere", sandboxes: { filesystem: "read+write" } }));
  assert.equal(store.reload().sandboxes.filesystem, "off");
  assert.equal(new StateStore(file).get().sandboxes.filesystem, "off");
 });
});

for (const version of [undefined, 1, 2]) {
 test(`legacy project state version ${version} migrates extras to custom`, () => {
  const migrated = mergeState({ version, scope: "project", extra_paths: ["/saved"], sandboxes: { filesystem: "read+write" } });
  assert.equal(migrated.version, 4);
  assert.equal(migrated.scope, "custom");
  assert.equal(migrated.sandboxes.filesystem, "read+write");
  assert.deepEqual(mergeState(migrated), migrated);
  assert.equal(mergeState({ version, scope: "project", extra_paths: [] }).scope, "project");
 });
}

test("version 3 project mode preserves inactive extras across updates and reloads", () => {
 withTempDir((dir) => {
  const file = join(dir, "permissions.json");
  const store = new StateStore(file);
  store.update(s => ({ ...s, scope: "custom", extra_paths: ["/saved"] }));
  for (const scope of ["project", "everywhere", "custom", "project"] as const) {
   store.update(s => ({ ...s, scope }));
   assert.equal(new StateStore(file).get().scope, scope);
   assert.deepEqual(store.reload().extra_paths, ["/saved"]);
  }
 });
});

for (const scope of ["project", "custom", "everywhere"] as const) {
 test(`${scope} normalizes filesystem with saved extras`, () => {
  const state = mergeState({ version: 3, scope, extra_paths: ["/saved"], sandboxes: { filesystem: "read" } });
  assert.equal(state.scope, scope);
  assert.equal(state.sandboxes.filesystem, scope === "everywhere" ? "off" : "read");
 });
}

test("legacy default scope with extras preserves access", () => {
 assert.equal(mergeState({ extra_paths: ["/saved"] }).scope, "custom");
 assert.deepEqual(mergeState({ version: 3, scope: "project", extra_paths: ["/saved"] }).extra_paths, ["/saved"]);
});

test("only an absent exception list gets the shipped host exception", () => {
	assert.deepEqual(checkPatterns([], true), { patterns: [] });
	assert.deepEqual(mergeState({}).unsandboxed_tools, ["^subagents_enable$"]);
	assert.deepEqual(mergeState({ unsandboxed_tools: [] }).unsandboxed_tools, []);
	assert.deepEqual(mergeState({ unsandboxed_tools: ["^host_tool$"] }).unsandboxed_tools, ["^host_tool$"]);
	assert.deepEqual(mergeState({ unsandboxed_tools: ["("] }).unsandboxed_tools, []);
});

test("root sessions start with defaults, resume persists, and children inherit policy", async () => {
 const {setChild,dropChild} = await import('./sessions.ts');
 withTempDir(dir => {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldFile = process.env.PI_PERMISSIONS_FILE;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_PERMISSIONS_FILE;
  try {
   // The global file is the template: a new session starts from it, and a change in
   // one session never reaches the other.
   saveState({...defaultState(),scope:'everywhere'});
   const parent = new StateStore(); parent.bindSession('root-one');
   assert.equal(parent.get().scope,'everywhere','a new session starts from the template');
   parent.update(s=>({...s,scope:'custom',extra_paths:['/opt/legacy']}));
   const later = new StateStore(); later.bindSession('later-root');
   assert.equal(later.get().scope,'everywhere','a later session still starts from the template, not from the first session');
   assert.deepEqual(later.get().extra_paths,[],'the first session change stays in its own file');
   parent.update(s=>({...s,scope:'custom',extra_paths:['/opt/extra'],sandboxes:{filesystem:'read+write',no_network:true}}));
   const resumed = new StateStore(); resumed.bindSession('root-one');
   assert.equal(resumed.get().scope,'custom');
   assert.deepEqual(resumed.get().extra_paths,['/opt/extra']);
   assert.equal(resumed.get().sandboxes.filesystem,'read+write');
   // A different root starts from the template, never from another root's choices.
   resumed.bindSession('root-two');
   assert.equal(resumed.get().scope,'everywhere');
   assert.deepEqual(resumed.get().extra_paths,[]);
   resumed.bindSession('root-one'); assert.equal(resumed.get().scope,'custom');
   resumed.bindSession('root-one'); assert.equal(resumed.get().scope,'custom');
   setChild('child-one',{parentSessionId:'root-one'});
   const child = new StateStore(); child.bindSession('child-one');
   assert.equal(child.get().scope,'custom');
   child.update(s=>({...s,scope:'project'})); parent.reload();
   assert.equal(parent.get().scope,'project');
   const explicit = new StateStore(join(dir,'explicit.json')); explicit.bindSession('root-one');
   assert.deepEqual(explicit.get(),defaultState());
   process.env.PI_PERMISSIONS_FILE = join(dir,'override.json');
   // PI_PERMISSIONS_FILE is the supported test override and keeps one shared file.
   const override = new StateStore(); override.bindSession('root-one');
   assert.deepEqual(override.get(),defaultState());
   override.update(s=>({...s,scope:'custom',extra_paths:['/opt/override']}));
   override.bindSession('root-two'); assert.equal(override.get().scope,'custom');
   resumed.bindSession('root-two'); assert.deepEqual(resumed.get().extra_paths,[]);
   resumed.bindSession('root-one'); assert.deepEqual(resumed.get().extra_paths,['/opt/extra']);
  } finally {
   dropChild('child-one');
   if(oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldAgent;
   if(oldFile === undefined) delete process.env.PI_PERMISSIONS_FILE; else process.env.PI_PERMISSIONS_FILE=oldFile;
  }
 });
});

test("custom mounts repair, cap, and drop paths the sandbox owns", async () => {
 const { mkdtempSync, mkdirSync, realpathSync } = await import("node:fs");
 const { join } = await import("node:path");
 const { tmpdir } = await import("node:os");
 const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-mounts-")));
 try {
  const real = join(dir, "data"); mkdirSync(real);
  const file = join(dir, "file"); writeFileSync(file, "x");
  const state = mergeState({ sandbox_mounts: [
   { path: real, writable: true },
   { path: real, writable: false },
   { path: file },
   { path: "relative/path" },
   { path: "/run/secrets" },
   { path: "/usr/share" },
   "nope",
  ] });
  // The duplicate collapses, the relative and protected paths are dropped, and one file is
  // a valid mount: that is how a credential or a config file is exposed.
  assert.deepEqual(state.sandbox_mounts, [
   { path: real, writable: true },
   { path: file, writable: false },
  ]);
  // A stored link resolves to its target, so the mount names the real directory.
  const link = join(dir, "link"); symlinkSync(real, link);
  assert.deepEqual(mergeState({ sandbox_mounts: [{ path: link }] }).sandbox_mounts, [{ path: real, writable: false }]);
  // The list is capped.
  const many = Array.from({ length: MAX_MOUNTS + 4 }, (_, index) => {
   const path = join(dir, `m${index}`); mkdirSync(path); return { path };
  });
  assert.equal(mergeState({ sandbox_mounts: many }).sandbox_mounts.length, MAX_MOUNTS);
  // An older file has no list, and loads with an empty one.
  assert.deepEqual(mergeState({ version: 3 }).sandbox_mounts, []);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("saving the defaults writes the template and leaves the session file alone", async () => {
 const { mkdtempSync, readFileSync } = await import("node:fs");
 const { join } = await import("node:path");
 const { tmpdir } = await import("node:os");
 const oldAgent = process.env.PI_CODING_AGENT_DIR;
 const oldFile = process.env.PI_PERMISSIONS_FILE;
 const dir = mkdtempSync(join(tmpdir(), "pi-defaults-"));
 process.env.PI_CODING_AGENT_DIR = dir;
 delete process.env.PI_PERMISSIONS_FILE;
 try {
  const session = new StateStore(); session.bindSession("root-defaults");
  session.update((s) => ({ ...s, scope: "custom", extra_paths: ["/opt/saved"] }));
  assert.deepEqual(loadState(statePath()).extra_paths, [], "the template is unchanged until the save");
  session.saveDefaults();
  assert.deepEqual(loadState(statePath()).extra_paths, ["/opt/saved"], "the template holds the saved values");
  assert.deepEqual(loadState(session.defaultsFile).extra_paths, ["/opt/saved"]);
  // A new session starts from the saved template.
  const next = new StateStore(); next.bindSession("later-defaults");
  assert.deepEqual(next.get().extra_paths, ["/opt/saved"]);
  // The session keeps its own file, so the save did not move it.
  const sessionFile = join(dir, "permissions", "sessions");
  assert.ok(readFileSync(join(sessionFile, `${createHash("sha256").update("root-defaults").digest("hex")}.json`), "utf8").includes("/opt/saved"));
 } finally {
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
  if (oldFile === undefined) delete process.env.PI_PERMISSIONS_FILE; else process.env.PI_PERMISSIONS_FILE = oldFile;
 }
});

test("session binding never writes into a read-only agent directory", () => {
 withTempDir(dir => {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldFile = process.env.PI_PERMISSIONS_FILE;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_PERMISSIONS_FILE;
  try {
   // A read-only mount refuses every write below it.
   const {mkdirSync, chmodSync, statSync} = fs;
   mkdirSync(join(dir,"permissions","sessions"),{recursive:true});
   chmodSync(dir,0o500);
   const store = new StateStore();
   // Binding only reads. A write that lands below the frozen directory fails.
   store.bindSession("frozen-root");
   assert.deepEqual(store.get(),defaultState());
   chmodSync(dir,0o700);
   assert.equal(statSync(join(dir,"permissions","sessions")).isDirectory(),true);
  } finally {
   if(oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldAgent;
   if(oldFile === undefined) delete process.env.PI_PERMISSIONS_FILE; else process.env.PI_PERMISSIONS_FILE=oldFile;
  }
 });
});
