import assert from "node:assert/strict";
import { test } from "node:test";
import { statusLine, statusText } from "./status.ts";
import type { FilesystemMode, PermissionsState } from "./types.ts";

const toolset = (name: string, enabled: boolean | "ask") => ({ name, patterns: [`^${name}$`], enabled, builtin: true });

const base = (filesystem: FilesystemMode, no_network = false, toolsets = [toolset("read", true)]): PermissionsState => ({
	version: 4, scope: "project", extra_paths: [], toolsets,
	sandboxes: { filesystem, no_network },
	unsandboxed_tools: [],
	sandbox_mounts: [],
});

test("the footer names the filesystem mode and nothing else when the rest is the default", () => {
	// The project scope, every toolset on, and an allowed network are the defaults, so a
	// quiet footer keeps only the filesystem mode.
	assert.equal(statusLine(base("read"), "all-tools", "linux"), "fs:read");
	assert.equal(statusLine(base("read+write"), "all-tools", "linux"), "fs:rw");
	assert.equal(statusLine(base("off"), "all-tools", "linux"), "fs:off");
	// No separator survives at the end, and no word repeats.
	for (const mode of ["off", "read", "read+write"] as const) {
		const line = statusLine(base(mode), "all-tools", "linux");
		assert.equal(line, line.trim());
		assert.equal(line.includes("  "), false, line);
	}
});

test("the line stays short in every combination", () => {
	const state = base("read+write", true, [toolset("read", true), toolset("write", "ask"), toolset("execute", false)]);
	const line = statusLine(state, "all-tools", "linux");
	assert.equal(line, "1/3 fs:rw net:off");
	assert.ok(line.length <= 32, `${line.length} chars: ${line}`);
});

test("a count appears only when a toolset is off or asks", () => {
	assert.equal(statusLine(base("read", false, [toolset("read", true), toolset("write", true)]), "all-tools", "linux"), "fs:read");
	assert.match(statusLine(base("read", false, [toolset("read", true), toolset("write", false)]), "all-tools", "linux"), /^1\/2 /);
	assert.match(statusLine(base("read", false, [toolset("read", "ask")]), "all-tools", "linux"), /^0\/1 /);
});

test("the network part appears only when connections are forbidden", () => {
	assert.equal(statusLine(base("off", false), "all-tools", "linux").includes("net:"), false);
	assert.equal(statusLine(base("off", true), "all-tools", "linux"), "fs:off net:off");
});

test("the scope adds a word only when it is not the project root", () => {
	const state = base("read");
	assert.equal(statusLine(state, "all-tools", "linux").includes("project"), false);
	state.scope = "custom";
	assert.equal(statusLine(state, "all-tools", "linux"), "fs:read custom");
	state.scope = "everywhere";
	assert.equal(statusLine(state, "all-tools", "linux"), "fs:read all");
});

test("on macOS the footer adds one word for the bash-only coverage", () => {
	const line = statusLine(base("read"), "all-tools", "darwin");
	assert.equal(line, "fs:read bash");
	// The bash entry point is exactly what the layer covers, so no note is needed there.
	assert.equal(statusLine(base("read"), "bash", "darwin"), "fs:read");
});

test("on Windows the footer names a disabled sandbox and no layer state", () => {
	for (const no_network of [false, true]) {
		const line = statusLine(base("read", no_network), "all-tools", "win32");
		assert.equal(line, "sb:off");
	}
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

test("the report keeps every detail that the footer drops", () => {
	for (const mode of ["off", "read", "read+write"] as const) {
		assert.match(statusText(base(mode)), new RegExp(`filesystem=${mode.replace("+", "\\+")}`));
	}
	assert.match(statusText(base("off", true)), /network=forbid connections/);
	assert.match(statusText(base("off", false)), /network=allow connections/);
});

test("the report names the unsandboxed tools", () => {
	const state = base("off");
	assert.match(statusText(state, "all-tools", "linux"), /unsandboxed tools: none/);
	state.unsandboxed_tools = ["^my_tool$", "^other_"];
	const report = statusText(state, "all-tools", "linux");
	assert.match(report, /unsandboxed tools: \^my_tool\$, \^other_/);
});

test("status distinguishes active roots from saved extras for every scope", () => {
	const state = base("off");
	state.extra_paths = ["/saved"];
	for (const scope of ["project", "custom", "everywhere"] as const) {
		state.scope = scope;
		const report = statusText(state);
		assert.match(report, /saved extra paths: 1/);
		assert.ok(report.includes(`scope: ${scope}`));
		const paths = report.split("\n").find((line) => line.startsWith("paths:"))!;
		assert.equal(paths.includes("/saved"), scope === "custom");
	}
});

test("the report lists the custom mounts with their mode", () => {
	const state = { ...base("read"), sandbox_mounts: [{ path: "/srv/data", writable: false }, { path: "/srv/out", writable: true }] };
	const report = statusText(state);
	assert.match(report, /custom mounts: \/srv\/data \(read-only\), \/srv\/out \(read-write\)/);
	assert.match(statusText(base("read")), /custom mounts: none/);
});
