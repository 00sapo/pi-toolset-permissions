import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeResult } from "./bridge.ts";
import { IsolatedRunner } from "./isolated-runner.ts";
import type { FilesystemMode } from "./types.ts";

const liveSkip = process.env.PI_BRIDGE_LIVE_TEST !== "1"
	? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available."
	: false;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function text(response: BridgeResult): string {
	const result = response.result as { content: Array<{ type: string; text?: string }> };
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

for (const filesystem of ["read", "read+write", "off"] satisfies FilesystemMode[]) {
	test(`live filesystem ${filesystem} enforces roots and preserves private runtime writes`, {
		skip: liveSkip, timeout: 90_000,
	}, async (t) => {
		assert.equal(process.platform, "linux");
		// `/tmp` is private inside a restricted sandbox, so a test there cannot tell a real
		// root violation from a write to the sandbox's own temporary tree. Use a directory
		// outside /tmp, and canonical paths to keep sibling roots distinct.
		const base = process.env.PI_FS_TEST_ROOT ?? join(homedir(), ".cache");
		await mkdir(base, { recursive: true });
		const directory = await realpath(await mkdtemp(join(base, "pi-filesystem-test-")));
		const project = join(directory, "project");
		const custom = join(directory, "custom");
		const outside = join(directory, "outside");
		let runner: IsolatedRunner | undefined;
		try {
			for (const root of [project, custom, outside]) {
				await mkdir(root);
				await writeFile(join(root, "sentinel.txt"), `sentinel:${root}`);
			}
			const escape = join(project, "outside-link");
			await symlink(outside, escape);
			const started = await IsolatedRunner.start({
				cwd: project, extensions: [], filesystem, paths: [project, custom],
				network: true, timeoutMs: 20_000,
			});
			runner = started.runner;
			for (const name of ["read", "write", "bash"]) {
				assert.ok(started.tools.some((tool) => tool.function.name === name), `Missing tool: ${name}`);
			}

			await t.test("direct filesystem calls cannot bypass the roots through a symlink", async () => {
				const script = `
					const fs = require("node:fs");
					const path = ${JSON.stringify(join(escape, "sentinel.txt"))};
					const results = {};
					for (const operation of ["read", "write"]) {
						try {
							if (operation === "read") fs.readFileSync(path, "utf8");
							else fs.writeFileSync(path, "symlink write");
							results[operation] = "allowed";
						} catch (error) { results[operation] = error.code; }
					}
					console.log(JSON.stringify(results));
				`;
				const response = await runner!.execute("bash", { command: `node -e ${shellQuote(script)}` });
				assert.equal(response.isError, false, text(response));
				const results = JSON.parse(text(response));
				for (const operation of ["read", "write"]) {
					if (filesystem === "off") assert.equal(results[operation], "allowed");
					else assert.match(results[operation], /^(ENOENT|EACCES|EPERM|EROFS)$/);
				}
				assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"),
					filesystem === "off" ? "symlink write" : `sentinel:${outside}`);
				await writeFile(join(outside, "sentinel.txt"), `sentinel:${outside}`);
			});

			for (const [root, allowed] of [[project, true], [custom, true], [outside, filesystem === "off"]] as const) {
				await t.test(`${root} read and write access`, async () => {
					const path = join(root, "sentinel.txt");
					const read = await runner!.execute("read", { path });
					assert.equal(read.isError, !allowed, text(read));
					if (allowed) assert.ok(text(read).includes(`sentinel:${root}`), text(read));
					const writable = allowed && filesystem !== "read";
					const write = await runner!.execute("write", { path, content: "updated sentinel" });
					// A write outside the roots can report success inside the sandbox and still never
					// reach the host, so the host file is the authority, not the tool result.
					assert.equal(await readFile(path, "utf8"), writable ? "updated sentinel" : `sentinel:${root}`, text(write));
					const created = join(root, "created.txt");
					await runner!.execute("write", { path: created, content: "new file" });
					if (writable) assert.equal(await readFile(created, "utf8"), "new file");
					else await assert.rejects(readFile(created), { code: "ENOENT" });
				});
			}

			await t.test("private configuration and session directories stay writable", async () => {
				const script = `
					const fs = require("node:fs");
					const path = require("node:path");
					const agent = process.env.PI_CODING_AGENT_DIR;
					if (!agent) throw new Error("Missing private agent directory");
					for (const name of ["models.json", "settings.json"]) {
						const file = path.join(agent, name);
						const content = fs.readFileSync(file, "utf8");
						JSON.parse(content);
						fs.writeFileSync(file, content);
					}
					const sessions = path.join(agent, "sessions");
					fs.mkdirSync(sessions, { recursive: true });
					const file = path.join(sessions, "filesystem-probe.jsonl");
					fs.writeFileSync(file, "private session\\n");
					if (fs.readFileSync(file, "utf8") !== "private session\\n") throw new Error("Session write failed");
					console.log(JSON.stringify({ agent, session: file }));
				`;
				const response = await runner!.execute("bash", { command: `node -e ${shellQuote(script)}` });
				assert.equal(response.isError, false, text(response));
				const result = JSON.parse(text(response));
				assert.match(result.agent, /^\/(tmp\/pi-bridge-agent-|run\/pi-agent)/);
				// These paths exist only inside bwrap, not in the corresponding host directory.
				await assert.rejects(readFile(result.session), { code: "ENOENT" });
			});

			await t.test("network isolation remains active independently of filesystem access", async () => {
				const script = `
					const net = require("node:net");
					const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
					socket.setTimeout(1500);
					socket.once("connect", () => { console.log("TCP_CONNECTED"); socket.destroy(); });
					socket.once("timeout", () => { console.log("TCP_BLOCKED: timeout"); socket.destroy(); });
					socket.once("error", error => { console.log("TCP_BLOCKED: " + error.code); socket.destroy(); });
				`;
				const response = await runner!.execute("bash", { command: `node -e ${shellQuote(script)}`, timeout: 5 });
				assert.equal(response.isError, false, text(response));
				assert.match(text(response), /TCP_BLOCKED: (ENETUNREACH|EHOSTUNREACH|EACCES|EPERM|timeout)/);
				assert.doesNotMatch(text(response), /TCP_CONNECTED/);
			});
		} finally {
			try { await runner?.close(); }
			finally { await rm(directory, { recursive: true, force: true }); }
		}
	});
}

for (const filesystem of ["read", "read+write"] as const) {
 test(`project symlink exceptions preserve filesystem ${filesystem}`, { skip: liveSkip, timeout: 90_000 }, async () => {
  const { sandboxRoots } = await import("./scope.ts");
  const { defaultState } = await import("./state.ts");
  const base = process.env.PI_FS_TEST_ROOT ?? join(homedir(), ".cache");
  await mkdir(base, { recursive: true });
  const directory = await realpath(await mkdtemp(join(base, "pi-link-test-")));
  const project = join(directory, "project");
  const target = join(directory, "target");
  const file = join(directory, "single.txt");
  const unrelated = join(directory, "unrelated.txt");
  let runner: IsolatedRunner | undefined;
  try {
   await mkdir(project);
   await mkdir(target);
   await writeFile(file, "before");
   await writeFile(unrelated, "private");
   await writeFile(join(target, "existing.txt"), "before");
   await symlink(target, join(project, "directory"));
   await symlink(file, join(project, "file"));
   const state = defaultState();
   state.sandboxes.filesystem = filesystem;
   const started = await IsolatedRunner.start({
    cwd: project, extensions: [], filesystem, paths: sandboxRoots(state, project), network: false, timeoutMs: 20_000,
   });
   runner = started.runner;
   for (const path of [join(project, "file"), join(project, "directory", "existing.txt")]) {
    const read = await runner.execute("read", { path });
    assert.equal(read.isError, false, text(read));
    const edit = await runner.execute("edit", { path, edits: [{ oldText: "before", newText: "after" }] });
    assert.equal(edit.isError, filesystem === "read", text(edit));
   }
   const created = join(project, "directory", "new", "created.txt");
   const write = await runner.execute("write", { path: created, content: "created" });
   assert.equal(write.isError, filesystem === "read", text(write));
   assert.equal(await readFile(file, "utf8"), filesystem === "read" ? "before" : "after");
   assert.equal(await readFile(join(target, "existing.txt"), "utf8"), filesystem === "read" ? "before" : "after");
   if (filesystem === "read+write") assert.equal(await readFile(join(target, "new", "created.txt"), "utf8"), "created");
   else await assert.rejects(readFile(join(target, "new", "created.txt")), { code: "ENOENT" });
   const outside = await runner.execute("read", { path: unrelated });
   assert.equal(outside.isError, true, text(outside));
  } finally {
   await runner?.close();
   await rm(directory, { recursive: true, force: true });
  }
 });
}
