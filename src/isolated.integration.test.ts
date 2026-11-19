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
		// The home directory holds only the named entries that the launcher mounts. Every
		// other entry of the host home stays outside, so the listing is compared against
		// that fixed list instead of against an empty directory.
		const probe = [
			`echo HOME=$HOME`,
			`ls -A "$HOME"`,
			`echo SEP`,
			`ls ${shellQuote(String(home))}/.ssh 2>&1 | head -1`,
			`ls /root 2>&1 | head -1`,
			`ls "$HOME/.pi/agent" 2>&1`,
		].join(" ; ");
		const response = await started.runner.execute("bash", { command: probe });
		const output = text(response);
		assert.match(output, /HOME=\/(tmp\/home|run\/pi-home)/);
		const [listing, rest] = output.split("SEP");
		const entries = listing.replace(/HOME=\S+/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
		for (const entry of entries) {
			assert.ok([".gitconfig", ".profile", ".pi"].includes(entry), `${entry} is not a mounted home entry`);
		}
		assert.equal(entries.length > 0, true, "the mounted home entries exist");
		assert.match(rest, /No such file or directory/, "the host home and /root stay outside");
		assert.doesNotMatch(output, /id_rsa|id_ed25519|known_hosts|authorized_keys/);
		// The agent directory is mounted entry by entry, so the credentials stay out.
		assert.doesNotMatch(rest, /auth\.json|models-store\.json|trust\.json|sessions/);
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
	let started: Awaited<ReturnType<typeof IsolatedRunner.start>> | undefined;
	try {
		started = await IsolatedRunner.start({ cwd, extensions: [], filesystem: "read", paths: [cwd], network: true, timeoutMs: 20_000 });
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
		await started?.runner.close();
		// A failed launch must not leave probe links in the project.
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
		// The host PATH directories are mounted on purpose, so a program that the outer shell
		// finds by name also resolves inside. Sensitive host directories must not appear, and
		// every PATH directory that names one must still exist inside the sandbox.
		const pathValue = /^PATH=(.*)$/m.exec(output)?.[1] ?? "";
		const directories = pathValue.split(":").filter(Boolean);
		for (const directory of directories) {
			assert.equal(directory.includes("/.ssh"), false, directory);
			assert.equal(directory.includes(`${home}/.config`), false, directory);
			assert.equal(directory.startsWith(`${home}/.pi/agent`), false, directory);
		}
		const missing = await started.runner.execute("bash", {
			command: `echo "$PATH" | tr ':' '\\n' | while read -r d ; do test -d "$d" || echo "MISSING:$d" ; done`,
		});
		const absent = text(missing).split("\n").filter((line) => line.startsWith("MISSING:")).map((line) => line.slice(8));
		for (const directory of absent) {
			// `/run` belongs to the sandbox. The relay fills `/run/pi-bin` and the private
			// agent bin after it starts, so an empty entry there is expected. Any other
			// absent entry is a host directory that the sandbox did not mount.
			assert.ok(directory === "/opt/local/bin" || directory.startsWith("/run/"), `PATH names a directory outside the sandbox: ${directory}`);
		}
	} finally {
		await started.runner.close();
	}
});

test("installed subagents use the parent model relay and gate child effects", {skip: liveSkip, timeout: 60_000}, async () => {
 const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const directory = await mkdtemp(join(tmpdir(), 'pi-real-subagent-'));
 const agent = join(directory, 'agent');
 await mkdir(join(agent, 'agents'), {recursive:true});
 await writeFile(join(agent, 'agents/probe.md'), '---\nname: probe\ndescription: Test child\ntools: read, write, bash\n---\nFollow the task.');
 let requests = 0;
 const approvals: any[] = [];
 const extension = join(process.env.HOME!, '.pi/agent/npm/node_modules/@gotgenes/pi-subagents/src/index.ts');
 const started = await IsolatedRunner.start({cwd:directory, extensions:[extension], filesystem:'read+write', paths:[directory], network:true, piAgentDir:agent,
  approve: async event => {approvals.push(event); return {block:true,reason:'CHILD_DENIED'};},
  streamModel: async function* (context, signal) {
   requests++;
   assert.equal(signal.aborted,false);
   const previous = context.messages.filter((m:any)=>m.role === 'toolResult');
   const message:any = {role:'assistant',api:'sandbox-parent',provider:'sandbox-parent',model:'parent',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason: previous.length ? 'stop' : 'toolUse',content:previous.length ? [{type:'text',text:'CHILD_FINISHED '+JSON.stringify(previous)}] : [{type:'toolCall',id:'child-write',name:'write',arguments:{path:join(directory,'denied.txt'),content:'forbidden'}}]};
   yield {type:'start',partial:message};
   yield {type:'done',reason:message.stopReason,message};
  },
 });
 try {
  const response = await started.runner.execute('subagent',{subagent_type:'probe',description:'Probe child permissions',prompt:'Perform the task.',model:'sandbox-parent/parent'});
  assert.equal(response.isError,false,JSON.stringify(response));
  assert.match(text(response),/CHILD_FINISHED/);
  assert.match(text(response),/CHILD_DENIED/);
  assert.equal(requests,2);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].toolName,'write');
  await assert.rejects(readFile(join(directory,'denied.txt')), {code:'ENOENT'});
 } finally {await started.runner.close(); await rm(directory,{recursive:true,force:true});}
});

test("a program on the host PATH resolves inside the namespace by its alias and by name", {skip:liveSkip,timeout:30_000},async()=>{
 const { execFileSync } = await import('node:child_process');
 const { existsSync } = await import('node:fs');
 // A version manager writes a shim as a symlink. Use any program that the host PATH
 // reaches through one, so the test does not depend on one particular tool.
 const found = execFileSync('/bin/sh',['-c','command -v jq || command -v zoxide || command -v bat || true'],{encoding:'utf8'}).trim();
 if(!found || !existsSync(found)) return;
 const program = found.split('/').pop()!;
 const {runner} = await IsolatedRunner.start({cwd,extensions:[],filesystem:'read',paths:[cwd],network:true});
 try {
  for(const command of [`${program} --version`,`${shellQuote(found)} --version`]) {
   const response = await runner.execute('bash',{command});
   assert.equal(response.isError,false,text(response));
   // A version string proves that the program ran, not that a shell resolved a path.
   assert.match(text(response),/\d+\.\d+/);
   assert.doesNotMatch(text(response),/command not found|No such file/);
  }
 } finally {await runner.close();}
});

