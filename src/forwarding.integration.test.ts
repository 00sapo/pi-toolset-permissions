import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiToolBridge } from "./bridge.ts";
import { defaultState } from "./state.ts";

const skip = process.env.PI_BRIDGE_LIVE_TEST !== "1" ? "Set PI_BRIDGE_LIVE_TEST=1 with Pi, Node.js, and bwrap available." : false;

for (const permissionsFirst of [false, true]) test(`real Pi normal startup forwards tools with permissions loaded ${permissionsFirst ? "first" : "last"}`, { skip, timeout: 90_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-forwarding-"));
	const agent = join(directory, "agent");
	const project = join(directory, "project");
	const packageRoot = join(directory, "foreign");
	await Promise.all([mkdir(agent), mkdir(project), mkdir(join(packageRoot, "src"), { recursive: true })]);
	const extension = join(packageRoot, "src/index.ts");
	const manual = join(packageRoot, "manual.ts");
	const bad = join(packageRoot, "bad.ts");
	await writeFile(join(packageRoot, "package.json"), '{"type":"module"}');
	await writeFile(join(packageRoot, "sibling.ts"), 'export const marker = "sibling";');
	await writeFile(extension, `
import { marker } from '../sibling.ts';
export default function(pi) {
 pi.registerCommand('fixture_reload',{description:'Reload fixture',handler:async(_args,ctx)=>{await ctx.reload();}});
 pi.on('session_start', () => pi.registerTool({name:'late_foreign',label:'Late',description:'Late fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:process.env.PI_TOOLSET_INNER === '1' ? 'late inner' : 'late host'}],details:{}})}));
 if (process.env.PI_TOOLSET_INNER !== '1') pi.registerTool({name:'write',label:'Missing override',description:'Missing override fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'must not use builtin'}],details:{}})});
 pi.registerTool({name:'read',label:'Override',description:'Override fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:process.env.PI_TOOLSET_INNER === '1' ? 'override inner' : 'override host'}],details:{}})});
 pi.registerTool({ name: 'foreign_runtime', label: 'Foreign', description: 'Runtime fixture', parameters: {type:'object',properties:{fail:{type:'boolean'},ask:{type:'boolean'},wait:{type:'boolean'}}},
 async execute(id,args,signal,update,ctx) {
  if (args.wait) { update?.({content:[{type:'text',text:'WAIT_READY'}],details:{}}); await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true})); throw new Error('cancelled'); }
  if (args.fail) throw new Error('ordinary request failure');
  if (args.ask) await ctx.ui.confirm('Foreign dialog','Continue?');
  update?.({content:[{type:'text',text:'progress'}],details:{}});
  return {content:[{type:'text',text: marker + ':' + (process.env.PI_TOOLSET_INNER === '1' ? 'inner' : 'host')}],details:{}};
 }});
 pi.registerTool({ name:'missing_inner',label:'Missing',description:'Missing fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'host leak'}],details:{}}), ...(process.env.PI_TOOLSET_INNER === '1' ? {exposure:'hidden'} : {}) });
}`);
	await writeFile(manual, `export default pi => pi.registerTool({name:'inner_only',label:'Inner',description:'Inner fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'manual inner'}],details:{}})});`);
	await writeFile(bad, `throw new Error('observed load failure');`);
	let child: ReturnType<typeof spawn> | undefined;
	let stderr = "";
	let reloadDone: (() => void) | undefined;
	let output = "";
	let dialogs = 0;
	const notices: any[] = [];
	const bridge = new PiToolBridge({ token: "forwarding-test", timeoutMs: 25_000, maxBodyBytes: 32 * 1024 * 1024,
		send: record => { child!.stdin!.write(JSON.stringify(record) + "\n"); },
		onUI: async record => { notices.push(record); if (record.method === "confirm") dialogs++; return { confirmed: true }; },
	});
	const server = createServer(bridge.handleRequest);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	const state = { ...defaultState(), sandboxes: { filesystem: "read" as const, no_network: true } };
	const save = () => writeFile(join(agent, "permissions.json"), JSON.stringify(state));
	try {
		await save();
		await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", compaction: {enabled:false}, retry:{enabled:false}, cacheWarming:"off" }));
		await writeFile(join(agent, "models.json"), JSON.stringify({providers:{bridge:{baseUrl:`http://127.0.0.1:${port}/v1`,api:"openai-completions",apiKey:"forwarding-test",authHeader:true,models:[{id:"bridge",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
		child = spawn(process.env.PI_TEST_EXECUTABLE ?? "pi", ["--mode","rpc","--no-session","--offline","--no-mcp","--no-context-files","--no-skills","--no-prompt-templates","--no-themes","--no-extensions","--provider","bridge","--model","bridge","--tools","*",
			...(permissionsFirst ? ["-e",fileURLToPath(new URL("./index.ts", import.meta.url)),"-e",extension] : ["-e",extension,"-e",fileURLToPath(new URL("./index.ts", import.meta.url))]),"--inner-extensions",JSON.stringify([manual,bad])],
			{ cwd: project, env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_PERMISSIONS_FILE:join(agent,"permissions.json")},stdio:"pipe" });
		child.stdout!.on("data", chunk => {
			bridge.feed(chunk);
			output += chunk.toString();
			let newline: number;
			while ((newline = output.indexOf("\n")) !== -1) {
				const record = JSON.parse(output.slice(0, newline));
				output = output.slice(newline + 1);
				if (record.type === "extension_ui_request" && record.statusKey === "isolated" && record.statusText?.startsWith("isolated:ready")) reloadDone?.();
			}
		});
		child.stderr!.on("data", chunk => { stderr += chunk; });
		child.on("error", error => bridge.fail(error));
		child.on("exit", () => bridge.fail(new Error(`Outer Pi exited: ${stderr}`)));
		const tools = await bridge.discover();
		assert.ok(tools.some(tool => tool.function.name === "inner_only"), JSON.stringify({stderr,notices,tools}));
		assert.ok(tools.some(tool => tool.function.name === "permissions"));
		const text = (response: any) => JSON.stringify(response.result);
		assert.match(text(await bridge.execute("foreign_runtime", {ask:true})), /sibling:inner/);
		assert.equal(dialogs, 1);
		assert.match(text(await bridge.execute("late_foreign", {})), /late inner/);
		assert.match(text(await bridge.execute("read", {})), /override inner/);
		assert.match(text(await bridge.execute("permissions", {action:"status"})), /sandboxes|filesystem/);
		assert.ok(notices.some(record => record.message?.includes("Sandbox extension unavailable:")));
		assert.ok(notices.every(record => !record.message?.includes("\n    at ")));
		const missing = await bridge.execute("missing_inner", {});
		assert.equal(missing.isError, true);
		assert.match(text(missing), /unavailable.*Unsandboxed/);
		const missingOverride = await bridge.execute("write", {});
		assert.equal(missingOverride.isError, true);
		assert.match(text(missingOverride), /unavailable.*Unsandboxed/);
		const failed = await bridge.execute("foreign_runtime", {fail:true});
		assert.equal(failed.isError, true);
		assert.match(text(failed), /ordinary request failure/);
		assert.doesNotMatch(text(failed), /incompatible/);
		assert.match(text(await bridge.execute("foreign_runtime", {})), /sibling:inner/);
		assert.match(text(await bridge.execute("inner_only", {})), /manual inner/);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Reload timeout: " + JSON.stringify({stderr,notices}))), 10_000);
			reloadDone = () => { clearTimeout(timer); resolve(); };
			child!.stdin!.write(JSON.stringify({type:"prompt",id:"reload",message:"/fixture_reload"}) + "\n");
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		await bridge.discover();
		assert.match(text(await bridge.execute("foreign_runtime", {})), /sibling:inner/);
		state.unsandboxed_tools = ["^foreign_runtime$", "^read$"];
		await save();
		assert.match(text(await bridge.execute("foreign_runtime", {})), /sibling:host/);
		assert.match(text(await bridge.execute("read", {})), /override host/);
		state.unsandboxed_tools = [];
		state.sandboxes = {filesystem:"off" as any,no_network:false};
		await save();
		assert.match(text(await bridge.execute("foreign_runtime", {})), /sibling:host/);
		assert.match(text(await bridge.execute("read", {})), /override host/);
		state.sandboxes = {filesystem:"read",no_network:true};
		await save();
		const controller = new AbortController();
		let ready = false;
		const cancelled = bridge.execute("foreign_runtime", {wait:true}, controller.signal, update => {
			if (JSON.stringify(update).includes("WAIT_READY")) { ready = true; controller.abort(); }
		});
		await assert.rejects(cancelled, /aborted/);
		assert.equal(ready, true);
	} finally {
		bridge.close();
		child?.stdin?.end();
		if (child && child.exitCode === null) {
			await new Promise<void>(resolve => { const timer = setTimeout(() => child!.kill("SIGKILL"), 5000); child!.once("exit", () => {clearTimeout(timer);resolve();}); });
		}
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, {recursive:true,force:true});
	}
});
