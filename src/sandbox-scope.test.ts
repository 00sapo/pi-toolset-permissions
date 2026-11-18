import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseSandbox, sandboxAvailability, sandboxMenuNote, sandboxRowMark, sandboxSectionTitle } from "./sandbox-scope.ts";

const platforms = ["linux", "darwin", "win32", "freebsd"] as const;

test("the section title always states coverage or the Windows restriction", () => {
	assert.equal(sandboxSectionTitle("linux"), "Sandboxes (ALL tools · Linux)");
	assert.equal(sandboxSectionTitle("darwin"), "Sandboxes (bash ONLY · macOS)");
	assert.equal(sandboxSectionTitle("win32"), "Sandboxes (DISABLED · use WSL2)");
});

test("the isolated executor covers every tool and runs on Linux only", () => {
	for (const platform of platforms) {
		const info = sandboxAvailability("all-tools", platform);
		assert.equal(info.target, "all-tools");
		assert.match(info.summary, /every tool/i);
		assert.match(info.summary, /Linux only/i);
		assert.equal(info.available, platform === "linux", platform);
	}
});

test("the default extension covers bash only and also works on macOS", () => {
	for (const platform of ["linux", "darwin"] as const) {
		const info = sandboxAvailability("bash", platform);
		assert.match(info.summary, /bash only/i);
		assert.equal(info.available, true, platform);
	}
	for (const platform of ["win32", "freebsd"] as const) {
		const info = sandboxAvailability("bash", platform);
		assert.equal(info.available, false, platform);
		assert.ok(info.reason && info.reason.length > 0, platform);
	}
});

test("every unavailable platform explains what to do and names the platform", () => {
	for (const target of ["all-tools", "bash"] as const) {
		for (const platform of platforms) {
			const info = sandboxAvailability(target, platform);
			if (info.available) {
				assert.equal(info.reason, undefined, `${target} ${platform}`);
				continue;
			}
			assert.equal(info.note, undefined, `${target} ${platform}`);
			assert.ok(info.reason, `${target} ${platform} has no reason`);
			const mentionsFix = /turn every layer off|turn the layers off/i.test(info.reason);
			assert.ok(mentionsFix, `${target} ${platform}: ${info.reason}`);
		}
	}
});

test("Windows and macOS name their workaround", () => {
	assert.match(String(sandboxAvailability("all-tools", "win32").reason), /WSL2/);
	assert.match(String(sandboxAvailability("all-tools", "darwin").reason), /macOS/);
	assert.match(String(sandboxAvailability("bash", "win32").reason), /WSL2/);
	assert.match(String(sandboxAvailability("bash", "win32").reason), /native Windows/i);
});

test("a missing backend never reports the layer as available", () => {
	for (const platform of platforms) {
		assert.equal(canUseSandbox("all-tools", platform), platform === "linux", platform);
		assert.equal(canUseSandbox("bash", platform), platform === "linux" || platform === "darwin", platform);
	}
});

test("the summary is one line and fits a menu row", () => {
	for (const target of ["all-tools", "bash"] as const) {
		for (const platform of platforms) {
			const { summary } = sandboxAvailability(target, platform);
			assert.equal(summary.includes("\n"), false, summary);
			assert.ok(summary.length <= 90, `${summary} is ${summary.length} characters`);
		}
	}
});

test("the menu note names the tool coverage, and it comes before the layer rows", () => {
	assert.equal(sandboxMenuNote("all-tools", "linux")[0], "Applies to all tools except exceptions.");
	assert.equal(sandboxMenuNote("bash", "linux")[0], "Applies to only bash.");
	assert.equal(sandboxMenuNote("bash", "darwin")[0], "Applies to only bash.");
});

test("an unavailable layer shows the reason instead of the coverage line", () => {
	const lines = sandboxMenuNote("all-tools", "win32");
	assert.equal(lines.length, 1);
	assert.match(lines[0], /WSL2/);
	assert.doesNotMatch(lines[0], /Applies to all tools/);
	assert.equal(sandboxRowMark("all-tools", "win32"), " [unavailable here]");
	assert.equal(sandboxRowMark("all-tools", "linux"), "");
});

test("macOS shows the coverage line and its sandbox-exec caveat", () => {
	const lines = sandboxMenuNote("bash", "darwin");
	assert.equal(lines[0], "Applies to only bash.");
	assert.match(lines[1] ?? "", /sandbox-exec/);
});
