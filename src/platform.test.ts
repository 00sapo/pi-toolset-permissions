import assert from "node:assert/strict";
import { test } from "node:test";
import { layersEnabled, platformPolicy, requiresBashOnly } from "./platform.ts";

test("Linux runs the isolated executor, which covers every tool", () => {
	const policy = platformPolicy("linux");
	assert.equal(policy.plan, "isolated");
	assert.equal(policy.entryPoint, "all-tools");
	assert.match(policy.coverage, /Every tool/);
	assert.equal(policy.reason, undefined);
	assert.equal(layersEnabled(policy), true);
	assert.equal(requiresBashOnly(policy), false);
});

test("macOS wraps bash only and says that other tools must be off", () => {
	const policy = platformPolicy("darwin");
	assert.equal(policy.plan, "bash-only");
	assert.equal(policy.entryPoint, "bash");
	assert.match(policy.coverage, /bash only/);
	assert.match(policy.coverage, /turn every other toolset off/i);
	assert.match(String(policy.reason), /macOS/);
	assert.equal(layersEnabled(policy), true);
	assert.equal(requiresBashOnly(policy), true);
});

test("Windows disables the layers and points at WSL2", () => {
	const policy = platformPolicy("win32");
	assert.equal(policy.plan, "disabled");
	assert.equal(layersEnabled(policy), false);
	assert.match(policy.coverage, /disabled/);
	assert.match(String(policy.reason), /WSL2/);
});

test("an unknown system disables the layers instead of guessing", () => {
	const policy = platformPolicy("freebsd");
	assert.equal(policy.plan, "disabled");
	assert.equal(layersEnabled(policy), false);
	assert.match(String(policy.reason), /freebsd/);
});

test("every platform names its coverage and gives one policy", () => {
	for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
		const policy = platformPolicy(platform);
		assert.ok(policy.coverage.length > 0, platform);
		assert.equal(policy.coverage.includes("\n"), false, platform);
		assert.ok(["isolated", "bash-only", "disabled"].includes(policy.plan), platform);
		assert.equal(layersEnabled(policy), policy.plan !== "disabled", platform);
		assert.equal(requiresBashOnly(policy), policy.plan === "bash-only", platform);
	}
});
