import assert from "node:assert/strict";
import { test } from "node:test";
import { decideCall, foreignTools, isOwnTool, layerKey, layersActive } from "./layers.ts";

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
