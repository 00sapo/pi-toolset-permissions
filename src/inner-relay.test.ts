import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// The relay's private runtime directories normally come from bubblewrap. Do not
// create /run entries on an ordinary host merely to exercise this regression.
const inSandbox = process.env.PI_TOOLSET_INNER === "1";
test("real relay forwards the shared subagents root and the selected Pi identity", { skip: !inSandbox && "Run inside the isolated runtime." }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-relay-environment-"));
	try {
		const fakePi = join(directory, "fake-pi");
		await writeFile(fakePi, `#!${process.execPath}\nconsole.log(JSON.stringify({root:process.env.PI_SUBAGENTS_TEMP_ROOT,args:process.argv.slice(2)}));\n`, {mode:0o700});
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./inner-relay.mjs",import.meta.url)),fakePi,"--no-session","--session-id","pi-sandbox-test"], {
			encoding:"utf8",timeout:10000, env:{PATH:process.env.PATH,PI_TOOLSET_INNER:"1",PI_BRIDGE_TOKEN:"test-token",PI_BRIDGE_SOCKET:"/run/pi-bridge/model.sock",PI_CODING_AGENT_DIR:join(directory,"private-agent"),PI_SUBAGENTS_TEMP_ROOT:join(directory,"shared-runs")},
		});
		assert.equal(result.status,0,result.stderr);
		assert.deepEqual(JSON.parse(result.stdout.trim()),{root:join(directory,"shared-runs"),args:["--no-session","--session-id","pi-sandbox-test"]});
	} finally { await rm(directory,{recursive:true,force:true}); }
});
