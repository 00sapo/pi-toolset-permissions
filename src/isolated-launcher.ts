import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface IsolatedLaunchOptions {
 socketPath: string;
 token: string;
 cwd: string;
 extensions: string[];
 readonly: boolean;
 /** True isolates the network namespace. False keeps the host network. The caller always passes it. */
 network: boolean;
 piPath?: string;
 nodePath?: string;
}

export interface IsolatedLaunchDependencies {
 platform: NodeJS.Platform;
 env: Readonly<Record<string, string | undefined>>;
 /** Return an absolute executable path, or null. No subprocess probes. */
 findExecutable: (name: string, path: string) => string | null;
}

function findExecutable(name: string, path: string): string | null {
 const candidates = isAbsolute(name) ? [name] : path.split(":").filter(isAbsolute).map((dir) => join(dir, name));
 for (const candidate of candidates) {
  try {
   accessSync(candidate, constants.X_OK);
   if (statSync(candidate).isFile()) return candidate;
  } catch { /* Try the next candidate. */ }
 }
 return null;
}

function absolutePath(value: string, label: string): void {
 if (!value || !isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute path without null bytes.`);
}

/**
 * Build argv without starting a process or creating files.
 * Inject dependencies for deterministic tests. The caller starts command with args and env, without a shell.
 *
 * The caller owns the authenticated HTTP server and its socket in a private host temporary directory.
 * Only that socket receives a separate mount. /tmp and /run hide common host sockets.
 * The control socket relay is only needed when network is true. Then bwrap adds --unshare-net,
 * bwrap initializes loopback in that namespace, and the relay listens on that loopback alone.
 * Without network isolation the inner Pi still uses the loopback relay. Loopback already exists in the host
 * network namespace, so the relay runs unchanged and the argv omits --unshare-net.
 * With network isolation, direct IP egress is blocked, but reachable host Unix services can still relay traffic.
 * The root bind still exposes files, credentials on disk, and sockets at other paths or mount aliases.
 * A private PID namespace hides host processes. /proc shows processes in that namespace.
 * This experimental boundary does not provide complete Unix socket isolation.
 * Read-only mode still permits writes to the private /tmp, /run, and /dev mounts.
 * Executables, extensions, cwd, and this helper must remain visible outside the masked host directories.
 * A bwrap runtime failure must stop launch. The caller must never retry without the sandbox.
 * PI_TOOLSET_INNER=1 lets the outer extension skip recursive bridge startup.
 */
export function buildIsolatedLaunch(
 options: IsolatedLaunchOptions,
 dependencies: IsolatedLaunchDependencies = { platform: process.platform, env: process.env, findExecutable },
): { command: string; args: string[]; env: Record<string, string> } {
 if (dependencies.platform !== "linux") throw new Error("The isolated launcher requires Linux.");
 absolutePath(options.socketPath, "socketPath");
 absolutePath(options.cwd, "cwd");
 if (!options.token || /[\x00-\x20\x7f]/.test(options.token)) throw new Error("The bridge token must be nonempty and contain no whitespace or control bytes.");
 if (typeof options.network !== "boolean") throw new Error("network must be a boolean.");
 const env: Record<string, string> = {
  PATH: dependencies.env.PATH ?? "/usr/bin:/bin",
  HOME: dependencies.env.HOME ?? "/tmp",
  LANG: dependencies.env.LANG ?? "C.UTF-8",
  TERM: dependencies.env.TERM ?? "dumb",
  PI_TOOLSET_INNER: "1",
  PI_BRIDGE_SOCKET: "/run/pi-bridge/model.sock",
  PI_BRIDGE_TOKEN: options.token,
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
 };
 const executable = (name: string): string => {
  const found = dependencies.findExecutable(name, env.PATH);
  if (!found) throw new Error(`Required executable is unavailable: ${name}`);
  absolutePath(found, "Executable");
  return found;
 };
 if (options.piPath !== undefined) absolutePath(options.piPath, "piPath");
 if (options.nodePath !== undefined) absolutePath(options.nodePath, "nodePath");
 const command = executable("bwrap");
 const pi = executable(options.piPath ?? "pi");
 const node = executable(options.nodePath ?? "node");
 const extensions = options.extensions.map((path) => {
  if (!path || path.includes("\0") || path.startsWith("builtin:")) throw new Error("Extensions must be explicit filesystem paths.");
  return resolve(options.cwd, path);
 });
 const args = [
  ...(options.network ? ["--unshare-net"] : []),
  "--die-with-parent", "--new-session", "--unshare-pid",
  options.readonly ? "--ro-bind" : "--bind", "/", "/",
  "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run",
  "--dir", "/run/pi-bridge", "--ro-bind", options.socketPath, env.PI_BRIDGE_SOCKET,
  "--chdir", options.cwd, "--", node,
  fileURLToPath(new URL("./inner-relay.ts", import.meta.url)), pi,
  "--mode", "rpc", "--no-session", "--provider", "bridge", "--model", "bridge",
  "--thinking", "off", "--tools", "*",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
  "--no-approve", "--offline",
  ...extensions.flatMap((path) => ["--extension", path]),
 ];
 return { command, args, env };
}
