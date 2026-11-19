import assert from "node:assert/strict";
import { test } from "node:test";
import { attachRegistryAdapter, concise, extensionRoot, extensionSources, unavailable } from "./forwarding.ts";

test("extension discovery deduplicates sources and excludes private and synthetic tools", () => {
	const tools = ["/foreign/ext.ts", "/foreign/ext.ts", "/own/index.ts", "<sdk:test>", "builtin:mcp"].map(path => ({ sourceInfo: { path } }));
	assert.deepEqual(extensionSources(tools, ["/own/index.ts"], ["/foreign/ext.ts", "./manual.ts"], "/project"), ["/foreign/ext.ts", "/project/manual.ts"]);
});

test("package mounts include sibling imports and use the nearest manifest", () => {
	assert.equal(extensionRoot("/packages/tool/src/index.ts", path => path === "/packages/tool/package.json"), "/packages/tool");
	assert.equal(extensionRoot("/extensions/foo.ts", () => false), "/extensions");
});

test("registry adapter preserves ownership across runtimes, definitions, and repeat refreshes", () => {
	class Runner { tools: any[]; constructor(tools: any[]) { this.tools = tools; } getAllRegisteredTools() { return this.tools; } }
	const anchorA = {}, anchorB = {};
	const entry = { definition: { name: "foreign", execute: () => "host" }, sourceInfo: { path: "/extension.ts" } };
	const first = new Runner([{ definition: anchorA }, entry]);
	const second = new Runner([{ definition: anchorB }, entry]);
	const untouched = new Runner([entry]);
	for (const [anchor, result] of [[anchorA, "A"], [anchorB, "B"]] as const) {
		assert.equal(attachRegistryAdapter(Runner, anchor, tool => tool === entry ? { ...tool, definition: { ...tool.definition, execute: () => result } } : tool), true);
	}
	assert.equal(first.getAllRegisteredTools()[1].definition.execute(), "A");
	assert.equal(second.getAllRegisteredTools()[1].definition.execute(), "B");
	assert.equal(untouched.getAllRegisteredTools()[0].definition.execute(), "host");
	assert.equal(first.getAllRegisteredTools()[1].sourceInfo, entry.sourceInfo);
	assert.equal(first.getAllRegisteredTools()[1].definition.execute(), "A");
	assert.equal(attachRegistryAdapter({}, {}, tool => tool), false);
});

test("diagnostics omit stack lines and require an explicit exemption", () => {
	assert.equal(concise(new Error("Unavailable\n at private/path.ts")), "Unavailable");
	assert.ok(concise("x".repeat(1000)).length <= 240);
	assert.match(unavailable("foreign"), /explicitly.*Unsandboxed/);
});
