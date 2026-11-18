// Standalone entry point. The launcher references this file by URL and never imports it.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, join } from "node:path";

async function main(): Promise<void> {
 const [pi, ...args] = process.argv.slice(2);
 const token = process.env.PI_BRIDGE_TOKEN;
 const socketPath = process.env.PI_BRIDGE_SOCKET;
 if (process.env.PI_TOOLSET_INNER !== "1" || !pi || !isAbsolute(pi) || !token || socketPath !== "/run/pi-bridge/model.sock") {
  throw new Error("The inner relay requires the isolated launcher environment and an absolute Pi executable path.");
 }
 // /tmp belongs to the namespace. Never write authentication to the host agent directory.
 const agentDir = await mkdtemp("/tmp/pi-bridge-agent-");
 const sockets = new Set<Socket>();
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
  await new Promise<void>((resolve, reject) => {
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
  // Pi 1.5.2 settings.md: these are the persisted autoCompact and autoRetry controls.
  // --no-approve prevents project settings from replacing these values.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
   compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
   cacheWarming: "off", defaultProjectTrust: "never",
  }), { mode: 0o600 });
  const env: Record<string, string> = {
   PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp",
   LANG: process.env.LANG ?? "C.UTF-8", TERM: process.env.TERM ?? "dumb",
   PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: socketPath, PI_BRIDGE_TOKEN: token,
   PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
  const child = spawn(pi, args, { stdio: "inherit", env });
  let signalCount = 0;
  const forward = (signal: NodeJS.Signals) => { child.kill(++signalCount > 1 ? "SIGKILL" : signal); };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  const onHup = () => forward("SIGHUP");
  const onServerError = (error: Error) => {
   console.error(`Inner relay failed: ${error.message}`);
   child.kill("SIGKILL");
   process.exitCode = 1;
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.on("SIGHUP", onHup);
  server.on("error", onServerError);
  try {
   const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
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
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(agentDir, { recursive: true, force: true });
 }
}

await main().catch((error: unknown) => {
 console.error(`Inner relay failed: ${error instanceof Error ? error.message : String(error)}`);
 process.exitCode = 1;
});
