import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { sandboxSessionId } from "./subagents-session.ts";
import { StateStore } from "./state.ts";

const launches: any[] = [];
const closes: any[] = [];
(globalThis as any).__fleetWiring = { launches, closes };
const hooks = registerHooks({ resolve(specifier, context, next) {
	let source: string | undefined;
	if (specifier === "@earendil-works/pi-coding-agent") source = `export const createCodingTools=()=>[]; export const getAgentDir=()=>'/missing'; export class ExtensionRunner { getAllRegisteredTools(){return [];} }`;
	if (specifier === "./ui.ts" && context.parentURL?.endsWith("/isolated.ts")) source = "export const openPermissions=async()=>{};";
	if (specifier === "./tool.ts" && context.parentURL?.endsWith("/isolated.ts")) source = "export const registerPermissionsTool=()=>{};";
	if (specifier === "./isolated-runner.ts" && context.parentURL?.endsWith("/isolated.ts")) source = `export class IsolatedRunner { static async start(options) { globalThis.__fleetWiring.launches.push(options); return { runner: { inventory:new Map(), execute:async()=>({result:{content:[]},isError:false}), close:async()=>{globalThis.__fleetWiring.closes.push(options.sessionId)} }, tools:[{type:'function',function:{name:'probe',parameters:{type:'object',properties:{}}}}], skipped:[] }; } }`;
	if (source !== undefined) return {url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true};
	return next(specifier, context);
}});
const { install } = await import("./isolated.ts");
hooks.deregister();

test("host lifecycle restores the alias after a later startup reset and never reuses another owner's runner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-fleet-wiring-"));
	const key = Symbol.for("pi-subagents.session-succession");
	const runtime = globalThis as any, saved = runtime[key];
	const previousInner = process.env.PI_TOOLSET_INNER;
	delete process.env.PI_TOOLSET_INNER;
	const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
	const store = new StateStore(join(directory, "state.json"));
	store.update(state => ({...state,sandboxes:{filesystem:"off",no_network:true}}));
	const pi = { on(name: string, fn: Function) {handlers.set(name,[...(handlers.get(name)??[]),fn]);}, events:{emit(){}}, registerTool(tool:any){tools.set(tool.name,tool);}, registerCommand(){}, registerFlag(){}, getFlag(){}, getActiveTools(){return [];}, setActiveTools(){}, getAllTools(){return [];} };
	const ctx = (id:string) => ({cwd:directory,sessionManager:{getSessionId:()=>id,getSessionFile:()=>undefined},ui:{setStatus(){},notify(){},theme:{fg:(_:any,s:any)=>s}}});
	const fire = async (name:string,event:any,context:any) => {for(const fn of handlers.get(name)??[])await fn(event,context);};
	try {
		install(pi as any,{registerPermissionsCommand:false,store});
		const a=ctx("a"),b=ctx("b");
		await fire("session_start",{reason:"startup"},a);
		assert.equal(launches.at(-1).sessionId,sandboxSessionId(a.sessionManager));
		runtime[key]?.delete("a"); // pi-subagents loaded after permissions
		await fire("resources_discover",{reason:"startup"},a);
		assert.ok(runtime[key].get("a").includes(sandboxSessionId(a.sessionManager)));
		// Calling with the same owner reuses the runner and repairs a cleared alias.
		const count=launches.length;
		runtime[key].delete("a");
		await tools.get("probe").execute("one",{},undefined,undefined,a);
		assert.equal(launches.length,count);
		assert.ok(runtime[key].get("a").includes(sandboxSessionId(a.sessionManager)));
		await tools.get("probe").execute("two",{},undefined,undefined,b);
		assert.equal(launches.length,count+1);
		assert.equal(launches.at(-1).sessionId,sandboxSessionId(b.sessionManager));
		assert.ok(closes.includes(sandboxSessionId(a.sessionManager)));
		assert.deepEqual(runtime[key].get("b"),[sandboxSessionId(b.sessionManager)]);
		await fire("session_shutdown",{reason:"reload"},b);
		assert.ok(!runtime[key].get("a").includes(sandboxSessionId(a.sessionManager)), "strip aliases before replacement truncation");
		await fire("session_start",{reason:"reload"},a);
		assert.equal(launches.at(-1).sessionId,sandboxSessionId(a.sessionManager));
		// Discovery must also revoke stale inherited aliases when layers are off.
		runtime[key].set("b",[sandboxSessionId(b.sessionManager),sandboxSessionId(a.sessionManager)]);
		store.update(state=>({...state,sandboxes:{filesystem:"off",no_network:false}}));
		await fire("resources_discover",{reason:"startup"},a);
		assert.ok(!runtime[key].get("b").includes(sandboxSessionId(a.sessionManager)));
	} finally {
		await fire("session_shutdown",{reason:"quit"},ctx("a"));
		if(saved===undefined) delete runtime[key];else runtime[key]=saved;
		if(previousInner===undefined)delete process.env.PI_TOOLSET_INNER;else process.env.PI_TOOLSET_INNER=previousInner;
		delete runtime.__fleetWiring;
		await rm(directory,{recursive:true,force:true});
	}
});
