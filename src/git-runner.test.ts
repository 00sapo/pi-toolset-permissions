import assert from "node:assert/strict";
import { test } from "node:test";
import { runGit } from "./git-runner.ts";

for (const program of ["git", "gh", "tea"] as const) test(`${program}: executes argv without a local shell`, async () => {
	const signal = new AbortController().signal;
	const args = ["status", "$(touch /tmp/never)", "; echo literal"];
	const expected = { stdout: "ok", stderr: "", code: 0, killed: false };
	const result = await runGit(async (name, values, options) => {
		assert.equal(name, program);
		assert.deepEqual(values, args);
		assert.deepEqual(options, { cwd: "/project", signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
		return expected;
	}, { program, args }, "/project", signal);
	assert.equal(result, expected);
});

test("git is the default program and explicit options preserve nonzero results", async () => {
	const result = await runGit(async (name, args, options) => {
		assert.equal(name, "git");
		assert.deepEqual(args, ["status"]);
		assert.equal(options.cwd, "/alternate");
		assert.equal(options.timeout, 2000);
		return { stdout: "", stderr: "error", code: 7, killed: false };
	}, { args: ["status"], cwd: "/alternate", timeout: 2 }, "/project");
	assert.equal(result.code, 7);
});

for (const input of [
	{ program: "bash", args: [] }, { args: "status" }, { args: [1] }, { args: ["bad\0arg"] },
	{ args: [], cwd: "" }, { args: [], cwd: "a\0b" },
	...[0, 601, 1.5, "60", null].map(timeout => ({ args: [], timeout })),
]) test(`git rejects invalid input ${JSON.stringify(input)}`, async () => {
	await assert.rejects(runGit(() => assert.fail("must not execute"), input as any, "/project"));
});
