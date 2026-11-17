import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./classify.ts";
import { defaultState } from "./state.ts";
import type { PermissionsState, Toolset } from "./types.ts";

function allOn(): PermissionsState {
	const state = defaultState();
	for (const toolset of state.toolsets) toolset.enabled = true;
	return state;
}

const EVERYTHING = allOn().toolsets;
const DEFAULTS = defaultState().toolsets;

function names(toolName: string, toolsets: Toolset[] = EVERYTHING): string[] {
	return classify(toolName, toolsets)?.toolsets ?? [];
}

const SHIPPED: Array<[string, string]> = [
	["read", "read"],
	["ls", "read"],
	["find", "read"],
	["grep", "read"],
	["tool_search", "read"],
	["hypa_read", "read"],
	["hypa_ls", "read"],
	["hypa_grep", "read"],
	["read_file", "read"],
	["list_files", "read"],
	["get_item", "read"],
	["file_grep", "read"],
	["write", "write"],
	["edit", "write"],
	["hypa_write", "write"],
	["hypa_edit", "write"],
	["write_file", "write"],
	["edit_note", "write"],
	["patch_file", "write"],
	["apply_patch", "write"],
	["bash", "execute"],
	["powershell", "execute"],
	["codemode", "execute"],
	["hypa_shell", "execute"],
	["hypa_bash", "execute"],
	["bash_run", "execute"],
	["shell_exec", "execute"],
	["task_bash", "execute"],
	["permissions", "permission"],
];

for (const [name, toolset] of SHIPPED) {
	test(`matches ${name} with the ${toolset} toolset`, () => {
		assert.deepEqual(names(name), [toolset], `expected ${name} to match ${toolset}`);
	});
}

test("unknown names match nothing", () => {
	assert.equal(classify("frobnicate", EVERYTHING), null);
	assert.equal(classify("", EVERYTHING), null);
	assert.equal(classify("deploy", EVERYTHING), null);
});

test("tool names are matched case insensitively", () => {
	assert.deepEqual(names("BASH"), ["execute"]);
	assert.deepEqual(names("Read"), ["read"]);
});

test("matching is unanchored, so users can write loose patterns", () => {
	const toolsets: Toolset[] = [{ name: "loose", patterns: ["deploy"], enabled: true, builtin: false }];
	assert.deepEqual(names("deploy_app", toolsets), ["loose"]);
});

test("names are reported in state order", () => {
	const toolsets: Toolset[] = [
		{ name: "first", patterns: ["^foo$"], enabled: true, builtin: false },
		{ name: "second", patterns: ["^foo$"], enabled: true, builtin: false },
	];
	assert.deepEqual(names("foo", toolsets), ["first", "second"]);
});

test("a disabled toolset is skipped", () => {
	const toolsets: Toolset[] = [
		{ name: "off", patterns: ["^foo$"], enabled: false, builtin: false },
	];
	assert.equal(classify("foo", toolsets), null);
});

test("the write tool is unknown at the default state", () => {
	assert.equal(classify("write", DEFAULTS), null);
	assert.equal(classify("edit", DEFAULTS), null);
	assert.deepEqual(names("read", DEFAULTS), ["read"]);
	assert.deepEqual(names("bash", DEFAULTS), ["execute"]);
});

test("an invalid pattern is skipped without throwing", () => {
	const toolsets: Toolset[] = [
		{ name: "broken", patterns: ["[", "^ok$"], enabled: true, builtin: false },
	];
	assert.deepEqual(names("ok", toolsets), ["broken"]);
	assert.equal(classify("other", toolsets), null);
});

test("a custom toolset adds an MCP name when on", () => {
	const toolset: Toolset = {
		name: "mcp-foo",
		patterns: ["^mcp__foo_"],
		enabled: true,
		builtin: false,
	};
	assert.deepEqual(names("mcp__foo__bar", [...EVERYTHING, toolset]), ["mcp-foo"]);
	assert.equal(classify("mcp__other__bar", [...EVERYTHING, toolset]), null);
});

test("a disabled custom toolset leaves its tool unknown", () => {
	const toolset: Toolset = {
		name: "mcp-foo",
		patterns: ["^mcp__foo_"],
		enabled: false,
		builtin: false,
	};
	assert.equal(classify("mcp__foo__bar", [...EVERYTHING, toolset]), null);
});

test("two toolsets can match the same tool", () => {
	const toolsets: Toolset[] = [
		...EVERYTHING,
		{ name: "mcp-a", patterns: ["^mcp__foo_"], enabled: true, builtin: false },
		{ name: "mcp-b", patterns: ["^mcp__foo_"], enabled: true, builtin: false },
	];
	assert.deepEqual(names("mcp__foo__bar", toolsets), ["mcp-a", "mcp-b"]);
});
