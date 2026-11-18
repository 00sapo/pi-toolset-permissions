import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCall, foreignTools, isOwnTool, layerKey, layersActive, ownPaths } from "./layers.ts";

test("no layer means no executor and no interception", () => {
	const layers = { readonly_bash: false, no_network: false };
	assert.equal(layersActive(layers), false);
	assert.equal(decideCall(layers, new Set(), "write"), undefined);
	assert.equal(decideCall(layers, new Set(["read"]), "bash"), undefined);
});

test("any layer blocks tools that the executor did not delegate", () => {
	for (const layers of [
		{ readonly_bash: true, no_network: false },
		{ readonly_bash: false, no_network: true },
		{ readonly_bash: true, no_network: true },
	]) {
		assert.equal(layersActive(layers), true);
		const delegated = new Set(["read", "bash"]);
		assert.equal(decideCall(layers, delegated, "read"), undefined);
		assert.equal(decideCall(layers, delegated, "permissions")?.block, true);
	}
});

test("each layer combination has its own key", () => {
	const keys = [
		{ readonly_bash: false, no_network: false },
		{ readonly_bash: true, no_network: false },
		{ readonly_bash: false, no_network: true },
		{ readonly_bash: true, no_network: true },
	].map(layerKey);
	assert.equal(new Set(keys).size, 4);
});

test("only this extension's tools count as own", () => {
	const own = "/ext/isolated.ts";
	assert.equal(isOwnTool(own, { sourceInfo: { source: "local", path: own } }), true);
	assert.equal(isOwnTool(own, { sourceInfo: { source: "local", path: "/ext/other.ts" } }), false);
	assert.equal(isOwnTool(own, { sourceInfo: { source: "builtin", path: own } }), false);
	assert.equal(isOwnTool(own, { sourceInfo: { source: "sdk" } }), false);
});

test("third-party extensions are reported and built-ins are not", () => {
	const own = "/ext/isolated.ts";
	const names = foreignTools(own, [
		{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
		{ name: "delegate", sourceInfo: { source: "local", path: own } },
		{ name: "hypa_shell", sourceInfo: { source: "local", path: "/ext/hypa.ts" } },
	]);
	assert.deepEqual(names, ["/ext/hypa.ts"]);
});

test("a tool registered by any file of this extension is own code", () => {
	const paths = ownPaths("/ext/src/isolated.ts");
	assert.deepEqual(paths, ["/ext/src/isolated.ts", "/ext/src/index.ts"]);
	const names = foreignTools(paths, [
		{ name: "permissions", sourceInfo: { source: "local", path: "/ext/src/index.ts" } },
		{ name: "delegate", sourceInfo: { source: "local", path: "/ext/src/isolated.ts" } },
		{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
		{ name: "hypa_shell", sourceInfo: { source: "local", path: "/other/hypa.ts" } },
	]);
	assert.deepEqual(names, ["/other/hypa.ts"]);
});

test("a module that is not isolated.ts reports only its own path", () => {
	assert.deepEqual(ownPaths("/ext/src/entry.ts"), ["/ext/src/entry.ts"]);
});
