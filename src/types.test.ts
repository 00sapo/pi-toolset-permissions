import assert from "node:assert/strict";
import test from "node:test";
import { allowsAsk, nextToolsetMode, toolsetMode } from "./types.ts";

test("toolset modes preserve the persisted representation", () => {
	assert.equal(toolsetMode(false), "off");
	assert.equal(toolsetMode(true), "on");
	assert.equal(toolsetMode("ask"), "ask");
});

test("toolset modes cycle off, on, ask, off", () => {
	assert.equal(nextToolsetMode(false, "read"), true);
	assert.equal(nextToolsetMode(true, "read"), "ask");
	assert.equal(nextToolsetMode("ask", "read"), false);
	for (const value of [false, true, "ask"] as const) {
		assert.equal(nextToolsetMode(nextToolsetMode(nextToolsetMode(value, "read"), "read"), "read"), value);
	}
});

test("the permissions toolset cycles off and on only", () => {
	assert.equal(nextToolsetMode(false, "permissions"), true);
	assert.equal(nextToolsetMode(true, "permissions"), false);
	assert.equal(nextToolsetMode("ask", "permissions"), false);
	assert.equal(allowsAsk("permissions"), false);
	assert.equal(allowsAsk("Permissions"), false);
	assert.equal(allowsAsk("read"), true);
});
