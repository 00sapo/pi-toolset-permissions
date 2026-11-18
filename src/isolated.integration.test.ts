import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BridgeResult, RpcRecord } from "./bridge.ts";
import { IsolatedRunner } from "./isolated-runner.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("../docs/fixtures/bridge-extension.ts", import.meta.url));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const liveSkip = process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false;

function text(response: BridgeResult): string {
	const result = response.result as { content: Array<{ type: string; text?: string }> };
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

// Connect by IP without DNS or application data.
const tcpProbe = `
	const net = require("node:net");
	const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
	socket.setTimeout(1500);
	socket.once("connect", () => { console.log("TCP_CONNECTED"); socket.destroy(); });
	socket.once("timeout", () => { console.error("TCP_BLOCKED: timeout"); socket.destroy(); process.exitCode = 23; });
	socket.once("error", (error) => { console.error("TCP_BLOCKED: " + error.code); socket.destroy(); process.exitCode = 23; });
`;

test("live isolated Pi discovers and executes tools inside bwrap without network isolation", {
	skip: liveSkip, timeout: 90_000,
}, async (t) => {
	assert.equal(process.platform, "linux");
	const sentinel = join(cwd, `.bridge-live-sentinel-${randomUUID()}`);
	const ui: RpcRecord[] = [];
	let runner: IsolatedRunner | undefined;
	try {
		await assert.rejects(lstat(sentinel), { code: "ENOENT" });
		const started = await IsolatedRunner.start({
			cwd, extensions: [fixture], filesystem: "read", paths: [cwd], network: false, timeoutMs: 20_000,
			onUI: async (request) => {
				ui.push(request);
				return { confirmed: true };
			},
		});
		runner = started.runner;
		const tools = started.tools.map((tool) => tool.function);
		for (const name of ["read", "write", "edit", "bash"]) {
			assert.ok(tools.some((tool) => tool.name === name), `Missing built-in tool: ${name}`);
		}
		const probes = tools.filter((tool) => /^bridge_probe_[a-f0-9]{32}$/.test(tool.name));
		assert.equal(probes.length, 1);
		const probe = probes[0];
		assert.equal(probe.parameters.type, "object");
		assert.deepEqual(probe.parameters.required, ["ask"]);

		await t.test("runtime tool preserves state, structured data, details, images, and UI", async () => {
			for (const [ask, count] of [[false, 1], [true, 2]] as const) {
				const response = await runner!.execute(probe.name, { ask });
				assert.equal(response.isError, false);
				assert.deepEqual(response.result, {
					content: [
						{ type: "text", text: `Probe ${count}` },
						{
							type: "image", mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
						},
					],
					structuredContent: { count, confirmed: ask },
					details: { count, confirmed: ask, nested: { values: ["fixture", null, 7] } },
				});
			}
			assert.equal(ui.length, 1);
			assert.equal(ui[0].type, "extension_ui_request");
			assert.equal(ui[0].method, "confirm");
			assert.equal(ui[0].title, "Bridge probe");
			assert.equal(ui[0].message, "Allow the live probe?");
			assert.equal(typeof ui[0].id, "string");
		});

		await t.test("read-only project rejects a write and leaves no host file", async () => {
			const response = await runner!.execute("write", { path: sentinel, content: "must not reach the host" });
			assert.equal(response.isError, true);
			assert.match(text(response), /EROFS|read-only file system/i);
			await assert.rejects(lstat(sentinel), { code: "ENOENT" });
		});

		await t.test("bash reaches an external TCP connection when network isolation is off", async () => {
			const response = await runner!.execute("bash", {
				command: `node -e ${shellQuote(tcpProbe)}`, timeout: 5,
			});
			assert.match(text(response), /TCP_CONNECTED/);
			assert.doesNotMatch(text(response), /TCP_BLOCKED/);
		});

		await t.test("cancel an active long bash call, then close", async () => {
			const controller = new AbortController();
			let sawReady = false;
			const pending = runner!.execute("bash", {
				command: "printf 'BRIDGE_BASH_READY\\n'; exec sleep 60", timeout: 65,
			}, controller.signal, (update) => {
				if (JSON.stringify(update).includes("BRIDGE_BASH_READY")) {
					sawReady = true;
					controller.abort();
				}
			});
			await assert.rejects(pending, /aborted/i);
			assert.equal(sawReady, true);
			await runner!.close();
			await assert.rejects(runner!.execute(probe.name, { ask: false }), /abort|closed/i);
		});
	} finally {
		try { await runner?.close(); }
		finally { await rm(sentinel, { force: true }); }
	}
});

test("live isolated Pi with network isolation still relays over loopback and cannot open external TCP", {
	skip: liveSkip, timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	let runner: IsolatedRunner | undefined;
	try {
		// Tool discovery proves the loopback relay works inside the private network namespace.
		const started = await IsolatedRunner.start({
			cwd, extensions: [fixture], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000,
		});
		runner = started.runner;
		assert.ok(started.tools.length > 0);
		const response = await runner.execute("bash", {
			command: `node -e ${shellQuote(tcpProbe)}`, timeout: 5,
		});
		assert.equal(response.isError, true);
		assert.match(text(response), /TCP_BLOCKED: (ENETUNREACH|EHOSTUNREACH|EACCES|EPERM|timeout)/);
		assert.doesNotMatch(text(response), /TCP_CONNECTED/);
	} finally {
		await runner?.close();
	}
});

test("the sandbox hides the home directory and host credentials", {
	skip: process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false,
	timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	const started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000 });
	try {
		const home = process.env.HOME;
		const probe = [
			`echo HOME=$HOME`,
			`ls -A "$HOME" | wc -l`,
			`ls -d ${shellQuote(String(home))}/* 2>&1 | head -1`,
			`ls ${shellQuote(String(home))}/.ssh 2>&1 | head -1`,
			`ls /root 2>&1 | head -1`,
		].join(" ; ");
		const response = await started.runner.execute("bash", { command: probe });
		const output = text(response);
		assert.match(output, /HOME=\/(tmp\/home|run\/pi-home)/);
		assert.match(output, /^0$/m, "the home directory inside the sandbox is empty");
		assert.match(output, /No such file or directory/);
		assert.doesNotMatch(output, /id_rsa|id_ed25519|known_hosts|auth\.json/);
	} finally {
		await started.runner.close();
	}
});

test("a symlink can only reach a mounted path", {
	skip: process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false,
	timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	const toHome = join(cwd, `.probe-home-${randomUUID()}`);
	const toEtc = join(cwd, `.probe-etc-${randomUUID()}`);
	await symlink("/home", toHome);
	await symlink("/etc/passwd", toEtc);
	const started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000 });
	try {
		const response = await started.runner.execute("bash", {
			command: `ls ${shellQuote(`${toHome}/.ssh`)} 2>&1 | head -2 ; echo SEP ; head -1 ${shellQuote(toEtc)}`,
		});
		const output = text(response);
		const [hostPart, mountedPart] = output.split("SEP");
		// The home directory name is recreated as an empty directory, so only its contents prove the point.
		assert.match(hostPart, /No such file or directory/, "the host home contents stay outside the mounts");
		assert.doesNotMatch(hostPart, /id_rsa|authorized_keys|config/);
		// /etc is mounted entry by entry, so the account database is the generated one.
		assert.match(mountedPart, /pi:x:/, "a mounted path stays reachable through a symlink");
		assert.doesNotMatch(mountedPart, /federico/);
	} finally {
		await started.runner.close();
		await rm(toHome, { force: true });
		await rm(toEtc, { force: true });
	}
});

test("the sandbox hides the host name and the host accounts", {
	skip: process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false,
	timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	const started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000 });
	try {
		const response = await started.runner.execute("bash", {
			command: "hostname ; id -un ; wc -l < /etc/passwd ; ls /etc/shadow /etc/ssh /etc/sudoers 2>&1 | head -3",
		});
		const output = text(response);
		assert.equal(output.includes(hostname()), false, "the host name stays outside the sandbox");
		assert.match(output, /^sandbox$/m);
		assert.match(output, /^pi$/m);
		assert.match(output, /^1$/m, "the sandbox has a single generated account");
		assert.doesNotMatch(output, /root:|federico/);
		assert.doesNotMatch(output, /ssh_host|sudoers: /);
	} finally {
		await started.runner.close();
	}
});

test("the host boot identifier is not readable", {
	skip: process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false,
	timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	const started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000 });
	try {
		const response = await started.runner.execute("bash", {
			command: "cat /proc/sys/kernel/random/boot_id 2>&1 ; echo SEP ; node -e \"console.log(require('node:crypto').randomBytes(8).length)\"",
		});
		const [bootPart, cryptoPart] = text(response).split("SEP");
		assert.match(bootPart, /No such file or directory/, "the host boot identifier stays outside the sandbox");
		assert.match(cryptoPart, /8/, "random data still works");
	} finally {
		await started.runner.close();
	}
});

test("the environment does not leak host paths or names", {
	skip: process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 on Linux with bwrap, Pi, and Node.js available." : false,
	timeout: 90_000,
}, async () => {
	assert.equal(process.platform, "linux");
	const started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read+write", paths: [cwd], network: true, timeoutMs: 20_000 });
	try {
		const response = await started.runner.execute("bash", { command: "env | sort" });
		const output = text(response);
		const home = String(process.env.HOME);
		// PWD is the mounted project, so only the variables that name host directories are checked.
		const named = output.split("\n").filter((line) => /^(PATH|HOME|PI_CODING_AGENT_DIR|TMPDIR|XDG_[A-Z_]+)=/.test(line));
		for (const line of named) {
			assert.equal(line.includes(`${home}/.ssh`), false, line);
			assert.equal(line.startsWith(`HOME=${home}`), false, line);
		}
		for (const name of ["SSH_AUTH_SOCK", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
			assert.equal(output.includes(name), false, name);
		}
		assert.match(output, /^HOME=\/(tmp\/home|run\/pi-home)$/m);
		assert.match(output, /^HOSTNAME=sandbox$/m);
		assert.match(output, /^PI_CODING_AGENT_DIR=\/(tmp\/pi-bridge-agent-|run\/pi-agent)/m);
		assert.match(output, /^PATH=[^\n]*\/run\/pi-bin/m);
		assert.doesNotMatch(output, new RegExp(`\\nPATH=[^\\n]*${String(home)}`, "m"), "PATH does not name a host directory");
	} finally {
		await started.runner.close();
	}
});
