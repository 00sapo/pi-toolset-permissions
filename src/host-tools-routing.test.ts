import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { StateStore } from "./state.ts";
import { evaluateCall } from "./gate.ts";

const runtime:any={hostCalls:[],innerCalls:[]};(globalThis as any).__hostRouting=runtime;
const hooks=registerHooks({resolve(specifier,context,next){
	let source:string|undefined;
	if(specifier==="@earendil-works/pi-coding-agent")source=`export const createCodingTools=()=>[]; export const getAgentDir=()=>'/missing'; export class ExtensionRunner {constructor(tools){this.tools=tools}getAllRegisteredTools(){return this.tools}} globalThis.__hostRouting.Runner=ExtensionRunner;`;
	if(specifier==="./ui.ts"&&context.parentURL?.endsWith("/isolated.ts"))source="export const openPermissions=async()=>{};";
	if(specifier==="./tool.ts"&&context.parentURL?.endsWith("/isolated.ts"))source="export const registerPermissionsTool=()=>{};";
	if(specifier==="./isolated-runner.ts"&&context.parentURL?.endsWith("/isolated.ts"))source=`export class IsolatedRunner {static async start(){return {runner:{inventory:new Map(['git','ssh'].map(name=>[name,{path:'/package/src/host-tools.ts'}])),execute:async(name,args)=>{globalThis.__hostRouting.innerCalls.push({name,args});return {result:{content:[{type:'text',text:'inner'}]},isError:false}},close:async()=>{}},tools:['git','ssh'].map(name=>({type:'function',function:{name,parameters:{type:'object',properties:{}}}})),skipped:[]}}}`;
	if(source!==undefined)return {url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true};return next(specifier,context);
}});
const {install}=await import("./isolated.ts");hooks.deregister();

test("packaged host tools honor removable exceptions and still obey on/off/ask",async()=>{
	const directory=await mkdtemp(join(tmpdir(),"pi-host-routing-"));
	const inner=process.env.PI_TOOLSET_INNER;delete process.env.PI_TOOLSET_INNER;
	const store=new StateStore(join(directory,"state.json"));
	store.update(state=>({...state,sandboxes:{filesystem:"off",no_network:true}}));
	const handlers=new Map<string,Function[]>(),registered:any[]=[];
	const source={source:"local",path:"/package/src/host-tools.ts"};
	const entries=['git','ssh'].map(name=>({sourceInfo:source,definition:{name,execute:async()=>{runtime.hostCalls.push(name);return {content:[{type:'text',text:'host'}]}}}}));
	const pi={registerTool:(tool:any)=>registered.push(tool),registerCommand(){},registerFlag(){},getFlag(){},events:{emit(){}},on:(name:string,fn:Function)=>handlers.set(name,[...(handlers.get(name)??[]),fn]),getAllTools:()=>entries.map(e=>({name:e.definition.name,sourceInfo:source})),getActiveTools:()=>['git','ssh'],setActiveTools(){}};
	const ctx={cwd:directory,sessionManager:{getSessionId:()=>"host-routing"},ui:{setStatus(){},notify(){},theme:{fg:(_:any,s:any)=>s}}};
	const fire=async(name:string)=>{for(const fn of handlers.get(name)??[])await fn({reason:'startup'},ctx)};
	try{
		install(pi as any,{registerPermissionsCommand:false,store});
		const anchor=registered.find(tool=>tool.name==="__permissions_executor_anchor");
		const registry=new runtime.Runner([{definition:anchor,sourceInfo:{path:"own"}},...entries]);
		const wrapped=registry.getAllRegisteredTools().slice(1).map((entry:any)=>entry.definition);
		await fire('session_start');await fire('resources_discover');
		for(const tool of wrapped){
			assert.equal(evaluateCall(store.get(),tool.name,{},directory).block,false);
			assert.match(JSON.stringify(await tool.execute('id',{},undefined,undefined,ctx)),/host/);
		}
		assert.deepEqual(runtime.hostCalls,['git','ssh']);
		store.update(state=>({...state,unsandboxed_tools:[]}));
		for(const tool of wrapped)assert.match(JSON.stringify(await tool.execute('id',{},undefined,undefined,ctx)),/inner/);
		assert.deepEqual(runtime.hostCalls,['git','ssh'],"removing exceptions must not bypass sandbox routing");
		assert.deepEqual(runtime.innerCalls.map((call:any)=>call.name),['git','ssh']);
		for(const enabled of [false,'ask'] as const){
			store.update(state=>({...state,toolsets:state.toolsets.map(t=>t.name==='dev'?{...t,enabled}:t)}));
			for(const name of ['git','ssh']){const decision=evaluateCall(store.get(),name,{},directory);assert.ok(decision.block);if(decision.block)assert.equal(decision.kind,enabled===false?'disabled':'ask');}
		}
	}finally{await fire('session_shutdown');if(inner===undefined)delete process.env.PI_TOOLSET_INNER;else process.env.PI_TOOLSET_INNER=inner;await rm(directory,{recursive:true,force:true});delete (globalThis as any).__hostRouting}
});
