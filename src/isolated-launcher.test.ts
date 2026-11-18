import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildIsolatedLaunch } from "./isolated-launcher.ts";

const options = {
	socketPath: "/tmp/private bridge/model.sock", token: "test-token", cwd: "/workspace/project",
	extensions: ["./extension one.ts", "/opt/extensions/two.ts"], readonly: true, network: true,
};
const dependencies = {
	platform: "linux" as NodeJS.Platform,
	env: { PATH: "/usr/bin:/bin", HOME: "/home/test", LANG: "C.UTF-8", TERM: "xterm", OPENAI_API_KEY: "real-secret", NODE_OPTIONS: "--require evil", HTTP_PROXY: "http://host", PI_CODING_AGENT_DIR: "/host/credentials", PI_TOOLSET_INNER: "wrong" },
	findExecutable: (name: string) => ({ bwrap: "/usr/bin/bwrap", pi: "/opt/pi/bin/pi", node: "/usr/bin/node" }[name] ?? (name.startsWith("/") ? name : null)),
};
const relay = fileURLToPath(new URL("./inner-relay.ts", import.meta.url));
const sandboxSocket = "/run/pi-bridge/model.sock";

/** Exact expected argv, in order, for each network mode. */
const expectedArgs = (network: boolean): string[] => [
	...(network ? ["--unshare-net"] : []),
	"--die-with-parent", "--new-session", "--unshare-pid", "--ro-bind", "/", "/",
	"--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run",
	"--dir", "/run/pi-bridge", "--ro-bind", options.socketPath, sandboxSocket, "--chdir", options.cwd, "--",
	"/usr/bin/node", relay, "/opt/pi/bin/pi",
	"--mode", "rpc", "--no-session", "--provider", "bridge", "--model", "bridge",
	"--thinking", "off", "--tools", "*",
	"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
	"--no-approve", "--offline",
	"--extension", "/workspace/project/extension one.ts", "--extension", "/opt/extensions/two.ts",
];

test("network isolation adds --unshare-net to the exact argv", () => {
	const plan = buildIsolatedLaunch(options, dependencies);
	assert.equal(plan.command, "/usr/bin/bwrap");
	assert.deepEqual(plan.args, expectedArgs(true));
	assert.equal(plan.args.filter((arg) => arg === "--unshare-net").length, 1);
});

test("network without isolation omits only --unshare-net", () => {
	const isolated = buildIsolatedLaunch({ ...options, network: true }, dependencies);
	const open = buildIsolatedLaunch({ ...options, network: false }, dependencies);
	assert.deepEqual(open.args, expectedArgs(false));
	assert.deepEqual(open.args, isolated.args.slice(1));
	assert.equal(open.args.includes("--unshare-net"), false);
	assert.deepEqual(open.env, isolated.env);
	assert.equal(open.command, isolated.command);
});

test("both network modes keep the masks, private namespaces, and the socket bind", () => {
	for (const network of [true, false]) {
		const { args } = buildIsolatedLaunch({ ...options, network }, dependencies);
		const sandboxArgs = args.slice(0, args.indexOf("--"));
		for (const pair of [["--dev", "/dev"], ["--proc", "/proc"], ["--tmpfs", "/tmp"], ["--tmpfs", "/run"], ["--dir", "/run/pi-bridge"], ["--ro-bind", options.socketPath]]) {
			const values = sandboxArgs.flatMap((arg, index) => arg === pair[0] ? [sandboxArgs[index + 1]] : []);
			assert.ok(values.includes(pair[1]), `${network}: missing ${pair[0]} ${pair[1]}`);
		}
		assert.ok(sandboxArgs.includes(sandboxSocket));
		assert.ok(sandboxArgs.includes("--die-with-parent"));
		assert.ok(sandboxArgs.includes("--new-session"));
		assert.ok(sandboxArgs.includes("--unshare-pid"));
		assert.equal(sandboxArgs.filter((arg) => arg === "--unshare-net").length, network ? 1 : 0);
		assert.equal(args.includes("/tmp/private bridge"), false);
		assert.equal(args.includes(options.token), false);
	}
});

test("read-write mode changes only the root mount in both network modes", () => {
	for (const network of [true, false]) {
		const ro = buildIsolatedLaunch({ ...options, network }, dependencies);
		const rw = buildIsolatedLaunch({ ...options, network, readonly: false }, dependencies);
		const expected = [...ro.args];
		const rootBind = expected.indexOf("--ro-bind");
		expected[rootBind] = "--bind";
		assert.deepEqual(rw, { ...ro, args: expected });
		assert.equal(expected.indexOf("--unshare-net"), network ? 0 : -1);
	}
});

test("both filesystem modes isolate process IDs and mount namespace-local proc", () => {
	for (const readonly of [true, false]) {
		for (const network of [true, false]) {
			const { args } = buildIsolatedLaunch({ ...options, readonly, network }, dependencies);
			const sandboxArgs = args.slice(0, args.indexOf("--"));
			assert.ok(sandboxArgs.includes("--unshare-pid"));
			const proc = sandboxArgs.indexOf("--proc");
			assert.ok(proc >= 0);
			assert.equal(sandboxArgs[proc + 1], "/proc");
		}
	}
});

test("rejects a non-boolean network value instead of guessing a default", () => {
	for (const network of [undefined, null, 0, 1, "true", "false", {}, []]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, network } as any, dependencies), /network must be a boolean/, String(network));
	}
	for (const network of [true, false]) {
		assert.doesNotThrow(() => buildIsolatedLaunch({ ...options, network }, dependencies));
	}
});

test("environment is an allowlist, not inherited credentials or loader settings", () => {
	for (const network of [true, false]) {
		const plan = buildIsolatedLaunch({ ...options, network }, dependencies);
		assert.deepEqual(plan.env, {
			PATH: "/usr/bin:/bin", HOME: "/home/test", LANG: "C.UTF-8", TERM: "xterm",
			PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
			PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		});
		assert.deepEqual(buildIsolatedLaunch({ ...options, network }, { ...dependencies, env: {} }).env, {
			PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", TERM: "dumb",
			PI_TOOLSET_INNER: "1", PI_BRIDGE_SOCKET: sandboxSocket, PI_BRIDGE_TOKEN: "test-token",
			PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		});
	}
});

test("explicit pi and Node paths remain separate argv entries", () => {
	const plan = buildIsolatedLaunch({ ...options, piPath: "/opt/my pi/pi", nodePath: "/opt/my node/node" }, dependencies);
	assert.equal(plan.args[plan.args.indexOf("--") + 1], "/opt/my node/node");
	assert.equal(plan.args[plan.args.indexOf("--") + 2], relay);
	assert.equal(plan.args[plan.args.indexOf("--") + 3], "/opt/my pi/pi");
});

test("unsupported platforms and missing executables fail closed", () => {
	for (const platform of ["darwin", "win32"] as const) {
		assert.throws(() => buildIsolatedLaunch(options, { ...dependencies, platform }), /Linux/);
	}
	for (const missing of ["bwrap", "pi", "node", "/missing/pi", "/missing/node"]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, ...(missing.endsWith("/pi") ? { piPath: missing } : {}), ...(missing.endsWith("/node") ? { nodePath: missing } : {}) }, {
			...dependencies, findExecutable: (name: string) => name === missing ? null : dependencies.findExecutable(name),
		}), /executable/);
	}
});

test("rejects invalid socket, cwd, token, and extension arguments", () => {
	for (const change of [{ socketPath: "relative.sock" }, { cwd: "relative" }, { token: "" }, { token: "a\nb" }, { extensions: ["builtin:mcp"] }, { extensions: [""] }, { cwd: "/bad\0path" }]) {
		assert.throws(() => buildIsolatedLaunch({ ...options, ...change }, dependencies));
	}
});

test("does not mutate caller input or dependencies", () => {
	const before = JSON.stringify({ options, env: dependencies.env });
	assert.deepEqual(buildIsolatedLaunch(options, dependencies), buildIsolatedLaunch(options, dependencies));
	assert.equal(JSON.stringify({ options, env: dependencies.env }), before);
});
