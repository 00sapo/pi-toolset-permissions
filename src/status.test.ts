import assert from "node:assert/strict";
import { test } from "node:test";
import { statusLine, statusText } from "./status.ts";
import type { PermissionsState } from "./types.ts";

const base = (readonly_bash: boolean, no_network = false): PermissionsState => ({
	version: 2, scope: "project", extra_paths: [], toolsets: [],
	sandboxes: { readonly_bash, no_network },
});

test("on Linux the footer names full coverage when a layer is on", () => {
	assert.match(statusLine(base(true), "all-tools", "linux"), /sandboxes:1\/2 all tools/);
	assert.doesNotMatch(statusLine(base(true), "all-tools", "linux"), /bash only here/);
});

test("with no layer on the footer says off", () => {
	assert.match(statusLine(base(false), "all-tools", "linux"), /sandboxes:off/);
});

test("on macOS the footer warns that full coverage is bash only", () => {
	const line = statusLine(base(true), "all-tools", "darwin");
	assert.match(line, /all tools/);
	assert.match(line, /bash only here/);
});

test("on Windows the footer says the sandbox is disabled", () => {
	const line = statusLine(base(true), "all-tools", "win32");
	assert.match(line, /sandbox:disabled/);
	assert.doesNotMatch(line, /sandboxes:1\/2/);
});

test("the text report names the coverage for each platform", () => {
	assert.match(statusText(base(true), "all-tools", "linux"), /Every tool runs inside the sandbox/);
	const mac = statusText(base(true), "bash", "darwin");
	assert.match(mac, /bash only/);
	assert.match(mac, /turn every other toolset off/i);
	const windows = statusText(base(true), "bash", "win32");
	assert.match(windows, /disabled on Windows/);
	assert.match(windows, /WSL2/);
});
