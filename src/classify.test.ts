import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./classify.ts";
import { defaultState } from "./state.ts";
import type { Risk, Toolset } from "./types.ts";

const BUILTINS = defaultState().toolsets;

const SHIPPED: Array<[string, Risk]> = [
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
];

for (const [name, risk] of SHIPPED) {
	test(`classifies ${name} as ${risk}`, () => {
		const result = classify(name, BUILTINS);
		assert.ok(result, `expected ${name} to match`);
		assert.equal(result.risk, risk);
	});
}

test("unknown names return null", () => {
	assert.equal(classify("frobnicate", BUILTINS), null);
	assert.equal(classify("", BUILTINS), null);
	assert.equal(classify("deploy", BUILTINS), null);
	assert.equal(classify("permissions", BUILTINS), null);
});

test("tool names are matched case insensitively", () => {
	assert.equal(classify("BASH", BUILTINS)?.risk, "execute");
	assert.equal(classify("Read", BUILTINS)?.risk, "read");
});

test("matching is unanchored, so users can write loose patterns", () => {
	const toolsets: Toolset[] = [
		{ name: "loose", risk: "read", patterns: ["deploy"], enabled: true, builtin: false },
	];
	assert.equal(classify("deploy_app", toolsets)?.risk, "read");
});

test("the most severe risk wins", () => {
	const toolsets: Toolset[] = [
		{ name: "low", risk: "read", patterns: ["^foo$"], enabled: true, builtin: false },
		{ name: "mid", risk: "write", patterns: ["^foo$"], enabled: true, builtin: false },
		{ name: "high", risk: "execute", patterns: ["^foo$"], enabled: true, builtin: false },
	];
	const result = classify("foo", toolsets);
	assert.ok(result);
	assert.equal(result.risk, "execute");
	assert.deepEqual(result.toolsets, ["low", "mid", "high"]);
});

test("write wins over read when both match", () => {
	const toolsets: Toolset[] = [
		{ name: "reader", risk: "read", patterns: ["^mix$"], enabled: true, builtin: false },
		{ name: "writer", risk: "write", patterns: ["^mix$"], enabled: true, builtin: false },
	];
	assert.equal(classify("mix", toolsets)?.risk, "write");
});

test("names are reported in state order", () => {
	const toolsets: Toolset[] = [
		{ name: "first", risk: "read", patterns: ["^foo$"], enabled: true, builtin: false },
		{ name: "second", risk: "write", patterns: ["^foo$"], enabled: true, builtin: false },
	];
	assert.deepEqual(classify("foo", toolsets)?.toolsets, ["first", "second"]);
});

test("a disabled custom toolset is skipped", () => {
	const toolsets: Toolset[] = [
		{ name: "off", risk: "execute", patterns: ["^foo$"], enabled: false, builtin: false },
	];
	assert.equal(classify("foo", toolsets), null);
});

test("builtin toolsets always apply, even with enabled false", () => {
	const toolsets: Toolset[] = [
		{ name: "read", risk: "read", patterns: ["^read$"], enabled: false, builtin: true },
	];
	assert.equal(classify("read", toolsets)?.risk, "read");
});

test("a custom toolset reclassifies an extension name", () => {
	const toolsets: Toolset[] = [
		...BUILTINS,
		{ name: "deploy", risk: "execute", patterns: ["^deploy_"], enabled: true, builtin: false },
	];
	const result = classify("deploy_app", toolsets);
	assert.ok(result);
	assert.equal(result.risk, "execute");
	assert.deepEqual(result.toolsets, ["deploy"]);
});

test("an invalid pattern is skipped without throwing", () => {
	const toolsets: Toolset[] = [
		{ name: "broken", risk: "write", patterns: ["[", "^ok$"], enabled: true, builtin: false },
	];
	assert.equal(classify("ok", toolsets)?.risk, "write");
	assert.equal(classify("other", toolsets), null);
});

test("a custom read toolset classifies an MCP tool as read when enabled", () => {
	const toolset: Toolset = {
		name: "mcp-foo",
		risk: "read",
		patterns: ["^mcp__foo_"],
		enabled: true,
		builtin: false,
	};
	const result = classify("mcp__foo__bar", [...BUILTINS, toolset]);
	assert.ok(result);
	assert.equal(result.risk, "read");
	assert.deepEqual(result.toolsets, ["mcp-foo"]);
	assert.deepEqual(classify("mcp__other__bar", [...BUILTINS, toolset]), null);
});

test("a disabled custom read toolset leaves its tool unknown", () => {
	const toolset: Toolset = {
		name: "mcp-foo",
		risk: "read",
		patterns: ["^mcp__foo_"],
		enabled: false,
		builtin: false,
	};
	assert.equal(classify("mcp__foo__bar", [...BUILTINS, toolset]), null);
});

test("execute wins over read when both toolsets match the same name", () => {
	const toolsets: Toolset[] = [
		...BUILTINS,
		{ name: "mcp-read", risk: "read", patterns: ["^mcp__foo_"], enabled: true, builtin: false },
		{ name: "mcp-exec", risk: "execute", patterns: ["^mcp__foo_"], enabled: true, builtin: false },
	];
	const result = classify("mcp__foo__bar", toolsets);
	assert.ok(result);
	assert.equal(result.risk, "execute");
	assert.deepEqual(result.toolsets, ["mcp-read", "mcp-exec"]);
});
