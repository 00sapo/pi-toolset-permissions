import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SshRunner } from "./ssh-runner.ts";
import type { SshInput, SshSnapshot } from "./ssh-runner.ts";

const cwd = process.cwd();
function runnerFor(script: string): SshRunner {
	return new SshRunner({ spawn: (_command, _args, options) => spawn(process.execPath, ["-e", script], options) });
}
async function execute(runner: SshRunner, input: SshInput, signal?: AbortSignal): Promise<SshSnapshot> {
	return await runner.execute(input, cwd, signal) as SshSnapshot;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await check()) return;
		await sleep(20);
	}
	assert.fail("condition did not become true");
}

test("SshRunner forwards native argv, cwd and inherited environment without shell or stdin", async () => {
	const args = ["-J", "jump", "-L8080:target:80", "-R", "9000:target:90", "-D1080", "-W", "target:22", "-N", "host"];
	const runner = new SshRunner({ spawn: (command, argv, options) => {
		assert.equal(command, "ssh");
		assert.deepEqual(argv, ["-oBatchMode=yes", "-T", "-oRequestTTY=no", "-oForkAfterAuthentication=no", "-oControlMaster=no", "-oControlPath=none", ...args]);
		assert.equal(options.cwd, tmpdir());
		assert.equal(options.env, process.env);
		assert.equal(options.shell, false);
		assert.equal(options.detached, process.platform !== "win32");
		assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
		return spawn(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"], options);
	} });
	try {
		const result = await execute(runner, { args, cwd: tmpdir() });
		assert.equal(result.stdout, "out");
		assert.equal(result.stderr, "err");
		assert.equal(result.code, 0);
		assert.equal(result.state, "exited");
		assert.equal(result.truncated, false);
	} finally { await runner.close(); }
});

test("SshRunner validates managed options and strict input before spawning", async () => {
	let calls = 0;
	const runner = new SshRunner({ spawn: () => { calls++; throw new Error("unexpected spawn"); } });
	const flags = [
		["-f"], ["-Nvf"], ["-t"], ["-tt"], ["-vNt"], ["-M"], ["-S", "/tmp/master"], ["-Ocheck"],
		["-o", "ForkAfterAuthentication=yes"], ["-oFoRkAfTeRaUtHeNtIcAtIoN=YES"],
		["-o=ForkAfterAuthentication=yes"], ["-o", "RequestTTY force"], ["-oRequestTTY=auto"],
		["-oControlMaster=auto"], ["-oControlPath=/tmp/master"], ["-oControlPersist=60"], ["-oBatchMode=no"],
	];
	// OpenSSH rejects -o=... syntax itself; it must not bypass our option filter either.
	for (const args of flags) await assert.rejects(execute(runner, { args }));
	for (const timeout of [0, -1, 601, 1.5, NaN, Infinity, "3"]) {
		await assert.rejects(execute(runner, { timeout } as SshInput), /timeout/);
	}
	for (const input of [
		{ args: ["a\0b"] }, { args: [3] }, { args: "host" }, { args: null }, { cwd: "x\0y" }, { cwd: "" }, { cwd: null }, { action: null },
		{ action: "other" }, { action: "status" }, { action: "stop", id: "" },
		{ action: "run", id: "x" }, { action: "list", id: "x" },
		{ action: "list", args: [] }, { action: "status", id: "x", timeout: 1 },
	]) await assert.rejects(execute(runner, input as SshInput));
	assert.equal(calls, 0);
	await runner.close();
});

test("SshRunner leaves remote command arguments and option values untouched", async () => {
	const runner = runnerFor("process.exit(0)");
	try {
		assert.equal((await execute(runner, { args: ["-L", "forward", "-oForkAfterAuthentication=no", "-oRequestTTY=no", "host", "echo", "-f", "-t"] })).code, 0);
		assert.equal((await execute(runner, { args: ["--", "host", "-f"] })).code, 0);
	} finally { await runner.close(); }
});

test("SshRunner start receipt, status/list snapshots, abort detachment and idempotent stop", async () => {
	const runner = runnerFor("process.stdout.write('ready');setInterval(()=>{},1000)");
	const controller = new AbortController();
	try {
		const receipt = await execute(runner, { action: "start" }, controller.signal);
		assert.equal(receipt.state, "running");
		assert.ok(receipt.pid);
		controller.abort();
		await waitFor(async () => (await execute(runner, { action: "status", id: receipt.id })).stdout === "ready");
		const status = await execute(runner, { action: "status", id: receipt.id }, controller.signal);
		assert.equal(status.state, "running");
		assert.equal(status.stopped, false);
		status.stdout = "mutated";
		const list = await runner.execute({ action: "list" }, cwd, controller.signal) as SshSnapshot[];
		assert.equal(list[0].stdout, "ready");
		const stopped = await execute(runner, { action: "stop", id: receipt.id });
		assert.equal(stopped.state, "exited");
		assert.equal(stopped.stopped, true);
		assert.deepEqual(await execute(runner, { action: "stop", id: receipt.id }), stopped);
		await assert.rejects(execute(runner, { action: "status", id: "missing" }), /Unknown/);
	} finally { await runner.close(); }
});

test("SshRunner returns immediate nonzero exit and missing executable errors", async () => {
	const failed = runnerFor("process.stderr.write('denied');process.exit(23)");
	const missing = new SshRunner({ spawn: (_command, args, options) => spawn(join(tmpdir(), `missing-ssh-${process.pid}`), args, options) });
	const thrown = new SshRunner({ spawn: () => { throw new Error("spawn failure"); } });
	try {
		const result = await execute(failed, {});
		assert.equal(result.code, 23);
		assert.equal(result.stderr, "denied");
		const receipt = await execute(failed, { action: "start" });
		await waitFor(async () => (await execute(failed, { action: "status", id: receipt.id })).state === "exited");
		assert.equal((await execute(failed, { action: "status", id: receipt.id })).code, 23);
		for (const action of ["run", "start"] as const) {
			const absent = await execute(missing, { action });
			assert.equal(absent.state, "exited");
			assert.match(absent.error!, /ENOENT/);
		}
		assert.match((await execute(thrown, {})).error!, /spawn failure/);
	} finally { await Promise.all([failed.close(), missing.close(), thrown.close()]); }
});

test("SshRunner retains only a rolling 1MiB across both output streams and drains on run", async () => {
	const runner = runnerFor(`process.stdout.write('a'.repeat(800000),()=>process.stderr.write('b'.repeat(800000),()=>process.stdout.write('END')))`);
	try {
		const result = await execute(runner, {});
		assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1024 * 1024);
		assert.equal(result.truncated, true);
		assert.ok(result.stdout.endsWith("END"));
		assert.equal(result.stderr, "b".repeat(800000));
		assert.equal(result.code, 0);
	} finally { await runner.close(); }
});

test("SshRunner run and start lifetime timeouts terminate and drain children", async () => {
	for (const action of ["run", "start"] as const) {
		const runner = runnerFor("process.stdout.write('alive');setInterval(()=>{},1000)");
		try {
			let result = await execute(runner, { action, timeout: 1 });
			if (action === "start") {
				assert.equal(result.state, "running");
				await waitFor(async () => (await execute(runner, { action: "status", id: result.id })).state === "exited");
				result = await execute(runner, { action: "status", id: result.id });
			}
			assert.equal(result.timedOut, true);
			assert.equal(result.state, "exited");
			assert.equal(result.stdout, "alive");
		} finally { await runner.close(); }
	}
});

test("SshRunner abort rejects before spawn and terminates a running run", async () => {
	const runner = runnerFor("process.stdout.write('ready');setInterval(()=>{},1000)");
	try {
		const already = new AbortController();
		already.abort();
		await assert.rejects(execute(runner, {}, already.signal), /aborted/);
		assert.deepEqual(await runner.execute({ action: "list" }, cwd), []);
		const controller = new AbortController();
		const pending = execute(runner, {}, controller.signal);
		await waitFor(async () => (await runner.execute({ action: "list" }, cwd) as SshSnapshot[])[0]?.stdout === "ready");
		controller.abort();
		const result = await pending;
		assert.equal(result.state, "exited");
		assert.equal(result.stopped, true);
		assert.match(result.error!, /aborted/);
	} finally { await runner.close(); }
});

test("SshRunner abort before start receipt cleans up the child", async () => {
	const controller = new AbortController();
	const runner = new SshRunner({ spawn: (_command, _args, options) => {
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
		controller.abort();
		return child;
	} });
	try {
		const result = await execute(runner, { action: "start" }, controller.signal);
		assert.equal(result.state, "exited");
		assert.equal(result.stopped, true);
	} finally { await runner.close(); }
});

test("SshRunner enforces 16 active children and close kills all, refusing future launches", async () => {
	const runner = runnerFor("setInterval(()=>{},1000)");
	try {
		const receipts = await Promise.all(Array.from({ length: 16 }, () => execute(runner, { action: "start" })));
		await assert.rejects(execute(runner, { action: "start" }), /limit/);
		await Promise.all([runner.close(), runner.close()]);
		const list = await runner.execute({ action: "list" }, cwd) as SshSnapshot[];
		assert.equal(list.length, receipts.length);
		assert.ok(list.every((item) => item.state === "exited" && item.stopped));
		await assert.rejects(execute(runner, {}), /closed/);
	} finally { await runner.close(); }
});

test("SshRunner retains at most 64 snapshots, evicting oldest finished entries", async () => {
	const runner = runnerFor("process.exit(0)");
	try {
		const first = await execute(runner, {});
		for (let batch = 0; batch < 4; batch++) await Promise.all(Array.from({ length: 16 }, () => execute(runner, {})));
		const list = await runner.execute({ action: "list" }, cwd) as SshSnapshot[];
		assert.equal(list.length, 64);
		assert.ok(list.every((item) => item.state === "exited"));
		await assert.rejects(execute(runner, { action: "status", id: first.id }), /Unknown/);
	} finally { await runner.close(); }
});

test("SshRunner kills descendants holding pipes after leader exit, escalating TERM-resistant children", { skip: process.platform === "win32" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "ssh-runner-test-"));
	const pidFile = join(directory, "pid");
	const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
	const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.stdout.write('leader done');process.exit(7)}},10)`;
	const runner = runnerFor(script);
	try {
		const started = Date.now();
		const result = await execute(runner, {});
		assert.ok(Date.now() - started < 4000);
		assert.equal(result.code, 7);
		assert.equal(result.stdout, "leader done");
		const pid = Number(await readFile(pidFile, "utf8"));
		await waitFor(async () => {
			try {
				process.kill(pid, 0);
				// Minimal containers may not reap orphan zombies immediately.
				return process.platform === "linux" && (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].startsWith("Z");
			} catch (error) { return ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code!); }
		});
	} finally { await runner.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SshRunner rejects unmanaged flags after the destination until the remote command begins", async () => {
	const runner = new SshRunner({spawn:()=>{throw new Error("must not spawn")}});
	try {
		for(const args of [["-N","host","-f"],["host","-tt"],["host","-S","/tmp/master","-Ocheck"],["host","-vNf"],["host","-J","jump","-f"]]) {
			await assert.rejects(execute(runner,{args}),/not managed safely/);
		}
	} finally {await runner.close()}
});
