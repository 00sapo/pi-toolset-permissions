import assert from "node:assert/strict";
import test from "node:test";
import { nextToolsetMode, toolsetMode } from "./types.ts";

test("toolset modes preserve the persisted representation", () => {
	assert.equal(toolsetMode(false), "off");
	assert.equal(toolsetMode(true), "on");
	assert.equal(toolsetMode("ask"), "ask");
});

test("toolset modes cycle off, on, ask, off", () => {
	assert.equal(nextToolsetMode(false), true);
	assert.equal(nextToolsetMode(true), "ask");
	assert.equal(nextToolsetMode("ask"), false);
	for (const value of [false, true, "ask"] as const) {
		assert.equal(nextToolsetMode(nextToolsetMode(nextToolsetMode(value))), value);
	}
});
