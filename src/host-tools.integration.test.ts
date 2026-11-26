import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { test } from "node:test";
import { PiToolBridge } from "./bridge.ts";
import { defaultState } from "./state.ts";

const executable=process.env.PI_TEST_EXECUTABLE;
const skip=process.env.PI_HOST_TOOLS_LIVE_TEST!=="1"||!executable ? "Set PI_HOST_TOOLS_LIVE_TEST=1 and PI_TEST_EXECUTABLE to test real Pi without network." : false;
test("real Pi loads package Git and SSH, manages fake SSH and closes it on shutdown",{skip,timeout:30000},async()=>{
	const directory=await mkdtemp(join(tmpdir(),"pi-host-tools-live-"));
	const agent=join(directory,"agent"),bin=join(directory,"bin");
	await mkdir(agent);await mkdir(bin);
	// This fake SSH runs only locally. It neither reads user config nor contacts hosts.
	await writeFile(join(bin,"ssh"),`#!${process.execPath}\nif(process.argv.includes('fake-fail'))process.exit(7);console.log('FAKE_SSH_READY');setInterval(()=>{},1000);`,{mode:0o700});
	let child:ReturnType<typeof spawn>|undefined,stderr="",end:Promise<void>|undefined;
	const bridge=new PiToolBridge({token:"host-tools-test",timeoutMs:10000,onUI:record=>{if(process.env.PI_HOST_TOOLS_DEBUG)console.error("UI",JSON.stringify(record));},send:record=>{child!.stdin!.write(JSON.stringify(record)+"\n");}});
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const checkpoint=(name:string)=>{if(process.env.PI_HOST_TOOLS_DEBUG)console.error(name,stderr.slice(-5000))};
	const server=createServer(bridge.handleRequest);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
	try{
		const port=(server.address() as any).port;
		await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProjectTrust:"never",compaction:{enabled:false},retry:{enabled:false},cacheWarming:"off"}));
		await writeFile(join(agent,"permissions.json"),JSON.stringify(defaultState()));
		await writeFile(join(agent,"models.json"),JSON.stringify({providers:{bridge:{baseUrl:`http://127.0.0.1:${port}/v1`,api:"openai-completions",apiKey:"host-tools-test",authHeader:true,models:[{id:"bridge",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
		child=spawn(executable!,["--mode","rpc","--no-session","--no-extensions","--no-mcp","--no-skills","--no-context-files","--offline","--provider","bridge","--model","bridge","--tools","*","-e",fileURLToPath(new URL("../",import.meta.url))],{cwd:directory,env:{...process.env,PATH:bin+delimiter+process.env.PATH,PI_CODING_AGENT_DIR:agent,PI_PERMISSIONS_FILE:join(agent,"permissions.json"),PI_TOOLSET_INNER:""},stdio:"pipe"});
		end=new Promise(resolve=>child!.once("close",()=>resolve()));
		watchdog=setTimeout(()=>{checkpoint("WATCHDOG");bridge.fail(new Error("live fixture deadline: "+stderr));child?.kill("SIGKILL")},20000);
		child.stdout!.on("data",chunk=>bridge.feed(chunk));child.stderr!.on("data",chunk=>stderr+=chunk);
		child.on("error",error=>bridge.fail(error));child.on("exit",code=>bridge.fail(new Error(`Pi exited ${code}: ${stderr}`)));
		checkpoint("discover");const tools=await bridge.discover();checkpoint("discovered");
		for(const name of ["git","ssh","permissions"])assert.ok(tools.some(tool=>tool.function.name===name),name);
		assert.ok(!tools.some(tool=>tool.function.name==="forge_cli"));
		checkpoint("git");const git=await bridge.execute("git",{args:["--version"]});assert.equal(git.isError,false,JSON.stringify(git));assert.match(JSON.stringify(git.result),/git version/);
		checkpoint("ssh-start");const started=await bridge.execute("ssh",{action:"start",args:["-N","fake-host"]});assert.equal(started.isError,false,JSON.stringify(started));
		const meta=(started.result as any).details;assert.equal(meta.state,"running");assert.equal(typeof meta.pid,"number");
		checkpoint("ssh-list");const listed=await bridge.execute("ssh",{action:"list"});assert.match(JSON.stringify(listed.result),new RegExp(meta.id));
		checkpoint("ssh-stop");const stopped=await bridge.execute("ssh",{action:"stop",id:meta.id});assert.equal(stopped.isError,false);assert.equal((stopped.result as any).details.state,"exited");
		assert.throws(()=>process.kill(meta.pid,0),{code:"ESRCH"});
		checkpoint("ssh-fail");const failure=await bridge.execute("ssh",{args:["fake-fail"]});assert.equal(failure.isError,true);assert.equal((failure.result as any).details.code,7);
		checkpoint("ssh-remainder");const remaining=await bridge.execute("ssh",{action:"start",args:["-N","fake-host"]});const pid=(remaining.result as any).details.pid;
		checkpoint("shutdown");child.stdin!.end();await end;checkpoint("closed");
		assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
	}finally{
		if(watchdog)clearTimeout(watchdog);bridge.close();child?.stdin?.end();
		if(child&&child.exitCode===null){const timer=setTimeout(()=>child!.kill("SIGKILL"),3000);child.kill("SIGTERM");await end;clearTimeout(timer)}
		server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
	}
});

test("native OpenSSH reads supplied config while managed safety options remain effective",{skip,timeout:15000},async()=>{
	const {SshRunner}=await import("./ssh-runner.ts");
	const directory=await mkdtemp(join(tmpdir(),"pi-ssh-config-"));
	const config=join(directory,"config");
	await writeFile(config,"Host config-probe\n HostName example.invalid\n User probe-user\n Port 22022\n ProxyJump jump-probe\n ForkAfterAuthentication yes\n RequestTTY force\n ControlMaster auto\n ControlPath /tmp/unmanaged-control\n");
	const manager=new SshRunner();
	try{
		// -G only prints the evaluated configuration. No host connection is made.
		const response=await manager.execute({args:["-G","-F",config,"config-probe"]},directory) as any;
		assert.equal(response.code,0,response.stderr);
		assert.match(response.stdout,/^hostname example\.invalid$/m);
		assert.match(response.stdout,/^user probe-user$/m);
		assert.match(response.stdout,/^port 22022$/m);
		assert.match(response.stdout,/^proxyjump jump-probe$/m);
		assert.match(response.stdout,/^batchmode yes$/m);
		assert.match(response.stdout,/^requesttty false$/m);
		assert.match(response.stdout,/^forkafterauthentication no$/m);
		assert.match(response.stdout,/^controlmaster false$/m);
		assert.doesNotMatch(response.stdout,/^controlpath \/tmp\/unmanaged-control$/m);
		for(const args of [
			["-G","-F",config,"-N","config-probe","-f"],
			["-G","-F",config,"config-probe","-tt"],
			["-G","-F",config,"config-probe","-S","/tmp/unmanaged-control","-Ocheck"],
		]) await assert.rejects(manager.execute({args},directory),/not managed safely/);
		const literal = await manager.execute({args:["-G","-F",config,"config-probe","echo","-f","-t"]},directory) as any;
		assert.equal(literal.code,0,literal.stderr);
		assert.match(literal.stdout,/^forkafterauthentication no$/m);
	}finally{await manager.close();await rm(directory,{recursive:true,force:true})}
});
