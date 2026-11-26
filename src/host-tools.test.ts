import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runners: any[] = [];
(globalThis as any).__hostToolRunners = runners;
const hooks=registerHooks({resolve(specifier,context,next){
	if(specifier==="./ssh-runner.ts"&&context.parentURL?.endsWith("/host-tools.ts"))return {url:"data:text/javascript,"+encodeURIComponent(`export class SshRunner { constructor(){this.calls=[];this.closed=false;globalThis.__hostToolRunners.push(this)} async execute(input,cwd,signal){this.calls.push({input,cwd,signal});if(input.action==='list')return [{id:'ssh-1',state:'running',stdout:'hidden',stderr:'hidden'}];return {id:'ssh-1',state:input.action==='status'?'exited':'running',code:input.action==='status'?7:null,stdout:'x'.repeat(80000),stderr:'',truncated:false}} async close(){this.closed=true} }`),shortCircuit:true};
	return next(specifier,context);
}});
const {default:extension}=await import("./host-tools.ts");hooks.deregister();

function fixture(){
	const tools=new Map<string,any>(),handlers=new Map<string,Function>();
	const executions:any[]=[];
	extension({registerTool:(tool:any)=>tools.set(tool.name,tool),on:(name:string,fn:Function)=>handlers.set(name,fn),exec:async(...args:any[])=>{executions.push(args);return {stdout:'git version test',stderr:'',code:0,killed:false}}} as any);
	const ctx=(id:string)=>({cwd:"/project",sessionManager:{getSessionId:()=>id}});
	const call=(name:string,input:any,id="session-a")=>tools.get(name).execute("call",input,undefined,undefined,ctx(id));
	return {tools,handlers,executions,ctx,call};
}

test("manifest packages Git and SSH without depending on the personal forge extension",()=>{
	const manifest=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
	assert.ok(manifest.pi.extensions.includes("./src/host-tools.ts"));
	const f=fixture();assert.deepEqual([...f.tools.keys()],["git","ssh"]);
	assert.ok(!manifest.pi.extensions.some((path:string)=>path.includes("forge-cli")));
});

test("git wrapper defaults to git and preserves forge programs, errors and consent guidance",async()=>{
	const f=fixture();
	const response=await f.call("git",{args:["status","--short"]});
	assert.equal(response.isError,false);assert.match(response.content[0].text,/git version test/);
	assert.equal(f.executions[0][0],"git");assert.deepEqual(f.executions[0][1],["status","--short"]);
	await f.call("git",{program:"tea",args:["--version"]});assert.equal(f.executions[1][0],"tea");
	assert.match(f.tools.get("git").description,/explicit user approval/);
});

test("SSH handles are isolated by session and cleaned on reload",async()=>{
	const f=fixture(),start=runners.length;
	await f.call("ssh",{action:"start",args:["-N","server"]});
	await f.call("ssh",{action:"status",id:"ssh-1"});
	await f.call("ssh",{action:"list"},"session-b");
	assert.equal(runners.length,start+2);
	assert.equal(runners[start].calls.length,2);assert.equal(runners[start+1].calls.length,1);
	await f.handlers.get("session_shutdown")!({reason:"reload"},f.ctx("session-a"));
	assert.equal(runners[start].closed,true);assert.equal(runners[start+1].closed,false);
	await f.call("ssh",{action:"list"});assert.equal(runners.length,start+3);
	await f.handlers.get("session_shutdown")!({},f.ctx("session-b"));
	await f.handlers.get("session_shutdown")!({},f.ctx("session-a"));
});

test("SSH output is bounded in text and never hidden in details; listing omits output",async()=>{
	const f=fixture();const status=await f.call("ssh",{action:"status",id:"ssh-1"});
	assert.ok(Buffer.byteLength(status.content[0].text)<52000);
	assert.equal(status.details.stdout,undefined);assert.equal(status.details.stderr,undefined);
	assert.equal(status.details.truncated,true);assert.equal(status.isError,false);
	const list=await f.call("ssh",{action:"list"});assert.doesNotMatch(JSON.stringify(list),/hidden/);
	await f.handlers.get("session_shutdown")!({},f.ctx("session-a"));
});
