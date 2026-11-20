import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiToolBridge } from "./bridge.ts";
import { defaultState } from "./state.ts";

const skip = process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 with Pi available." : false;

test("real Pi read/write toolsets support project symlinks without sandbox layers", { skip, timeout: 60_000 }, async () => {
 const directory = await mkdtemp(join(tmpdir(), "pi-host-links-"));
 const agent = join(directory, "agent");
 const project = join(directory, "project");
 const outside = join(directory, "outside");
 await Promise.all([mkdir(agent), mkdir(project), mkdir(outside)]);
 const file = join(outside, "existing.txt");
 const unrelated = join(outside, "unrelated.txt");
 await writeFile(file, "before");
 await writeFile(unrelated, "private");
 await symlink(outside, join(project, "directory"));
 await symlink(file, join(project, "file"));
 const state = defaultState();
 state.sandboxes = { filesystem: "off", no_network: false };
 state.toolsets = state.toolsets.map(entry => ({ ...entry, enabled: ["read", "write"].includes(entry.name) }));
 const save = () => writeFile(join(agent, "permissions.json"), JSON.stringify(state));
 let child: ReturnType<typeof spawn> | undefined;
 let stderr = "";
 const bridge = new PiToolBridge({ token: "host-link-test", timeoutMs: 20_000,
  send: record => { child!.stdin!.write(JSON.stringify(record) + "\n"); },
 });
 const server = createServer(bridge.handleRequest);
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const port = (server.address() as any).port;
 const text = (response: any): string => JSON.stringify(response.result);
 try {
  await save();
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { bridge: {
   baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "host-link-test", authHeader: true,
   models: [{ id: "bridge", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  child = spawn(process.env.PI_TEST_EXECUTABLE ?? "pi", ["--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "bridge", "--model", "bridge", "--tools", "read,write,edit,bash", "-e", fileURLToPath(new URL("./index.ts", import.meta.url))],
   { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PERMISSIONS_FILE: join(agent, "permissions.json") }, stdio: "pipe" });
  child.stdout!.on("data", chunk => bridge.feed(chunk));
  child.stderr!.on("data", chunk => { stderr += chunk; });
  child.on("error", error => bridge.fail(error));
  child.on("exit", () => bridge.fail(new Error(`Outer Pi exited: ${stderr}`)));
  await bridge.discover();
  for (const path of ["file", join(project, "directory", "existing.txt")]) {
   const read = await bridge.execute("read", { path });
   assert.equal(read.isError, false, text(read));
   assert.match(text(read), /before/);
  }
  const edit = await bridge.execute("edit", { path: "file", edits: [{ oldText: "before", newText: "after" }] });
  assert.equal(edit.isError, false, text(edit));
  assert.equal(await readFile(file, "utf8"), "after");
  const write = await bridge.execute("write", { path: "directory/new/nested.txt", content: "created" });
  assert.equal(write.isError, false, text(write));
  assert.equal(await readFile(join(outside, "new", "nested.txt"), "utf8"), "created");
  for (const [tool, input] of [
   ["read", { path: unrelated }],
   ["write", { path: file, content: "blocked" }],
   ["read", { path: "../outside/existing.txt" }],
   ["bash", { command: "pwd" }],
  ] as const) {
   const response = await bridge.execute(tool, input);
   assert.equal(response.isError, true, text(response));
   assert.match(text(response), /Blocked|disabled toolset/i);
  }
  for (const name of ["read", "write"]) {
   state.toolsets = state.toolsets.map(entry => entry.name === name ? { ...entry, enabled: false } : entry);
   await save();
   const response = await bridge.execute(name, name === "read" ? { path: "file" } : { path: "file", content: "blocked" });
   assert.equal(response.isError, true, text(response));
   assert.match(text(response), /disabled toolset/i);
  }
  assert.equal(await readFile(file, "utf8"), "after");
  assert.equal(await readFile(unrelated, "utf8"), "private");
 } finally {
  bridge.close();
  child?.stdin?.end();
  if (child && child.exitCode === null) await new Promise<void>(resolve => {
   const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
   child!.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
 }
});
