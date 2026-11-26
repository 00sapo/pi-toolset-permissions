import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { test } from "node:test";

const pi = process.env.PI_TEST_EXECUTABLE;
test("real Pi honors an explicit identity without persisting a session", {skip: !pi && "Set PI_TEST_EXECUTABLE to an installed Pi executable.", timeout:20000}, async () => {
	assert.ok(pi && isAbsolute(pi));
	await access(pi);
	const directory = await mkdtemp(join(tmpdir(),"pi-session-cli-"));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const agent = join(directory,"agent");await mkdir(agent);
		await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProjectTrust:"never",cacheWarming:"off"}));
		const identity="pi-sandbox-cli-test";
		const result = await new Promise<any>((resolve,reject)=>{
			child=spawn(pi!,["--mode","rpc","--no-session","--session-id",identity,"--no-extensions","--no-mcp","--no-context-files","--no-skills","--offline"],{cwd:directory,env:{...process.env,PI_CODING_AGENT_DIR:agent},stdio:"pipe"});
			let output="",stderr="",state:any;
			child.stdout!.on("data",chunk=>{output+=chunk;let n;while((n=output.indexOf("\n"))!==-1){const record=JSON.parse(output.slice(0,n));output=output.slice(n+1);if(record.id==="state"){state=record;child!.stdin!.end();}}});
			child.stderr!.on("data",chunk=>stderr+=chunk);
			child.on("error",reject);
			child.on("close",code=>{if(code!==0||!state)reject(new Error(`Pi exited ${code}: ${stderr}`));else resolve(state)});
			child.stdin!.write(JSON.stringify({type:"get_state",id:"state"})+"\n");
		});
		assert.equal(result.success,true);
		assert.equal(result.data.sessionId,identity);
		assert.equal(result.data.sessionFile,undefined);
		assert.ok(!(await readdir(agent)).includes("sessions"));
	} finally {
		if(child && child.exitCode===null)child.kill("SIGTERM");
		await rm(directory,{recursive:true,force:true});
	}
});
