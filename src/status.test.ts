import assert from "node:assert/strict";
import { test } from "node:test";
import { statusLine, statusText } from "./status.ts";
import type { FilesystemMode, PermissionsState } from "./types.ts";

const base = (filesystem: FilesystemMode, no_network = false): PermissionsState => ({
	version: 4, scope: "project", extra_paths: [], toolsets: [],
	sandboxes: { filesystem, no_network },
	unsandboxed_tools: [],
	sandbox_mounts: [],
});

test("on Linux the footer names full coverage when a layer is on", () => {
	assert.match(statusLine(base("read"), "all-tools", "linux"), /sandboxes:1\/2 all tools/);
	assert.doesNotMatch(statusLine(base("read"), "all-tools", "linux"), /bash only here/);
});

test("with no layer on the footer says off", () => {
	assert.match(statusLine(base("off"), "all-tools", "linux"), /sandboxes:off/);
});

test("on macOS the footer warns that full coverage is bash only", () => {
	const line = statusLine(base("read"), "all-tools", "darwin");
	assert.match(line, /all tools/);
	assert.match(line, /bash only here/);
});

test("on Windows the footer says the sandbox is disabled", () => {
	const line = statusLine(base("read"), "all-tools", "win32");
	assert.match(line, /sandbox:disabled/);
	assert.doesNotMatch(line, /sandboxes:1\/2/);
});

test("the text report names the coverage for each platform", () => {
	assert.match(statusText(base("read"), "all-tools", "linux"), /Every tool runs inside the sandbox/);
	const mac = statusText(base("read"), "bash", "darwin");
	assert.match(mac, /bash only/);
	assert.match(mac, /turn every other toolset off/i);
	const windows = statusText(base("read"), "bash", "win32");
	assert.match(windows, /disabled on Windows/);
	assert.match(windows, /WSL2/);
});

test("filesystem modes appear in reports and active counts ignore off", () => {
 for (const mode of ["off", "read", "read+write"] as const) {
  assert.ok(statusLine(base(mode), "all-tools", "linux").includes(`filesystem:${mode}`));
  assert.match(statusText(base(mode)), new RegExp(`filesystem=${mode.replace("+", "\\+")}`));
  assert.match(statusLine(base(mode, true), "all-tools", "linux"), mode === "off" ? /sandboxes:1\/2/ : /sandboxes:2\/2/);
 }
});

test("the report names the unsandboxed tools", () => {
	const state = base("off");
	assert.match(statusText(state, "all-tools", "linux"), /unsandboxed tools: none/);
	state.unsandboxed_tools = ["^my_tool$", "^other_"];
	const report = statusText(state, "all-tools", "linux");
	assert.match(report, /unsandboxed tools: \^my_tool\$, \^other_/);
});

test("status distinguishes active roots from saved extras for every scope", () => {
 const state = base("off"); state.extra_paths = ["/saved"];
 for (const scope of ["project", "custom", "everywhere"] as const) {
  state.scope = scope;
  const report = statusText(state);
  assert.match(report, /saved extra paths: 1/);
  assert.ok(report.includes(`scope: ${scope}`));
  const paths = report.split("\n").find(line => line.startsWith("paths:"))!;
  assert.equal(paths.includes("/saved"), scope === "custom");
  assert.ok(statusLine(state).includes(scope === "project" ? "PROJECT ONLY" : scope === "custom" ? "CUSTOM PATHS" : "EVERYWHERE"));
 }
});

test("the report lists the custom mounts with their mode", () => {
	const state = { ...base("read"), sandbox_mounts: [{ path: "/srv/data", writable: false }, { path: "/srv/out", writable: true }] };
	const report = statusText(state);
	assert.match(report, /custom mounts: \/srv\/data \(read-only\), \/srv\/out \(read-write\)/);
	assert.match(statusText(base("read")), /custom mounts: none/);
});
