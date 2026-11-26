// Standalone entry point. The launcher references this file by URL and never imports it.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";

import { isAbsolute, join } from "node:path";

async function main() {
 const [pi, ...args] = process.argv.slice(2);
 const token = process.env.PI_BRIDGE_TOKEN;
 const socketPath = process.env.PI_BRIDGE_SOCKET;
 if (process.env.PI_TOOLSET_INNER !== "1" || !pi || !isAbsolute(pi) || !token || socketPath !== "/run/pi-bridge/model.sock") {
  throw new Error("The inner relay requires the isolated launcher environment and an absolute Pi executable path.");
 }
 // /tmp belongs to the namespace. Never write authentication to the host agent directory.
 const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
 const agentDir = configuredAgentDir && configuredAgentDir !== "/run/pi-agent"
  ? configuredAgentDir
  : await mkdtemp("/tmp/pi-bridge-agent-");
 await mkdir(agentDir, { recursive: true });
 // PATH names only sandbox paths. Link the programs instead of naming their host directories.
 await mkdir("/run/pi-bin", { recursive: true });
 // A writable temp directory. A read-only scope can bind the host `/tmp` over the private one.
 const tempDir = process.env.TMPDIR;
 const subagentsRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
 if (tempDir) await mkdir(tempDir, { recursive: true });
 await Promise.all([
  symlink(pi, "/run/pi-bin/pi").catch(() => {}),
  symlink(process.execPath, "/run/pi-bin/node").catch(() => {}),
  ...(process.env.PI_BRIDGE_HYPA ? [symlink(process.env.PI_BRIDGE_HYPA, "/run/pi-bin/hypa").catch(() => {})] : []),
 ]);
 // A minimal account database. The host users and their home paths stay outside the sandbox.
 // With the filesystem layer off, `/etc` is the host one, so writing there would change the host.
 if (process.env.PI_BRIDGE_GENERATE_ACCOUNTS === "1") {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  await Promise.all([
   writeFile("/etc/passwd", `pi:x:${uid}:${gid}:Sandboxed user:/tmp/home:/bin/sh\n`, { mode: 0o444 }).catch(() => {}),
   writeFile("/etc/group", `pi:x:${gid}:\n`, { mode: 0o444 }).catch(() => {}),
  ]);
 }
 // The private agent directory holds no user configuration. Link the read-only entries in,
 // so `getAgentDir()` finds the rules, agents, and packages that the sandbox mounts. Pi writes
 // its own models and settings files below that directory, so those names stay unlinked. The
 // links are read-only, so the session list and the caches still go to the private directory.
 const GENERATED = new Set(["models.json", "settings.json"]);
 const hostAgentDir = process.env.PI_BRIDGE_HOST_AGENT_DIR;
 const agentEntries = (process.env.PI_BRIDGE_AGENT_ENTRIES ?? "").split(",").filter((name) => name && !GENERATED.has(name));
 if (hostAgentDir && agentEntries.length) {
  await Promise.all(agentEntries.map((name) => {
   const source = isAbsolute(name) ? name : `${hostAgentDir}/${name}`;
   return symlink(source, join(agentDir, name)).catch(() => {});
  }));
 }
 const sockets = new Set();
 const server = createServer({ allowHalfOpen: true }, (client) => {
  const upstream = createConnection({ path: socketPath, allowHalfOpen: true });
  for (const socket of [client, upstream]) {
   sockets.add(socket);
   socket.on("close", () => { sockets.delete(socket); });
  }
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  // A closed peer must not leave an unconnected or half-open socket behind.
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
 });
 try {
  await new Promise ((resolve, reject) => {
   server.once("error", reject);
   server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The inner relay did not receive a TCP port.");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
   providers: { bridge: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
    apiKey: "$PI_BRIDGE_TOKEN", authHeader: true,
    models: [{ id: "bridge", reasoning: false, input: ["text", "image"],
     contextWindow: 128000, maxTokens: 16384,
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
   } },
  }), { mode: 0o600 });
  // Child sessions inherit extensions from settings. The model relay appears there so
  // the root and every child load exactly one copy.
  // Pi 1.5.2 settings.md: these are the persisted autoCompact and autoRetry controls.
  // --no-approve prevents project settings from replacing these values.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
   extensions: process.env.PI_BRIDGE_MODEL_EXTENSION ? [process.env.PI_BRIDGE_MODEL_EXTENSION] : [],
   compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
   cacheWarming: "off", defaultProjectTrust: "never",
  }), { mode: 0o600 });
  const env = {
   PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp",
   HOSTNAME: process.env.HOSTNAME ?? "sandbox",
   LANG: process.env.LANG ?? "C.UTF-8", TERM: process.env.TERM ?? "dumb",
   PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: socketPath, PI_BRIDGE_TOKEN: token,
   PI_PARENT_MODEL_URL: `http://127.0.0.1:${address.port}`,
   PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
   ...(tempDir ? { TMPDIR: tempDir } : {}),
   // The host names the pi-subagents run directory and mounts it writable, so the inner
   // Pi must forward that name or pi-subagents falls back to a TMPDIR path that the host
   // cannot see. Without it a run started here never appears in the host fleet.
   ...(subagentsRoot ? { PI_SUBAGENTS_TEMP_ROOT: subagentsRoot } : {}),
  };
  const child = spawn(pi, args, { stdio: "inherit", env });
  let signalCount = 0;
  const forward = (signal) => { child.kill(++signalCount > 1 ? "SIGKILL" : signal); };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  const onHup = () => forward("SIGHUP");
  const onServerError = (error) => {
   console.error(`Inner relay failed: ${error.message}`);
   child.kill("SIGKILL");
   process.exitCode = 1;
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.on("SIGHUP", onHup);
  server.on("error", onServerError);
  try {
   const result = await new Promise ((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
   });
   process.exitCode = process.exitCode || result.code || (result.signal ? 1 : 0);
  } finally {
   process.removeListener("SIGTERM", onTerm);
   process.removeListener("SIGINT", onInt);
   process.removeListener("SIGHUP", onHup);
   server.removeListener("error", onServerError);
  }
 } finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise ((resolve) => server.close(() => resolve()));
  await rm(agentDir, { recursive: true, force: true });
 }
}

await main().catch((error) => {
 console.error(`Inner relay failed: ${error instanceof Error ? error.message : String(error)}`);
 process.exitCode = 1;
});
