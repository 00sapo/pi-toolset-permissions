import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGit } from "./git-runner.ts";
import { SshRunner } from "./ssh-runner.ts";

const string = { type: "string" };
const argv = { type: "array", items: string, description: "Individual arguments, not a local shell command." };
const cwd = { type: "string", minLength: 1, description: "Working directory. Defaults to the current project." };
const timeout = { type: "integer", minimum: 1, maximum: 600, description: "Seconds. Default 60 for a command; omitted means no lifetime limit for start." };

/** Keep displayed output bounded independently of the subprocess capture limit. */
function tail(value: string): { text: string; truncated: boolean } {
	const lines = value.split("\n");
	const last = lines.slice(-2000).join("\n");
	const bytes = Buffer.from(last);
	const text = bytes.length > 50 * 1024 ? bytes.subarray(-50 * 1024).toString("utf8").replace(/^\uFFFD/, "") : last;
	return { text, truncated: lines.length > 2000 || bytes.length > 50 * 1024 };
}

function result(text: string, details: Record<string, unknown>, isError = false) {
	const view = tail(text);
	return {
		content: [{ type: "text" as const, text: view.text + (view.truncated ? "\n[Only the final 2000 lines or 50 KB are shown.]" : "") }],
		details: { ...details, truncated: Boolean(details.truncated) || view.truncated },
		isError,
	};
}

/** Separate entry point: removing a sandbox exception keeps the normal executor routing. */
export default function hostTools(pi: ExtensionAPI): void {
	// Never share process handles between independent SDK sessions. A session owns
	// its runner until shutdown/reload; calls do not create any background resource.
	const sessions = new Map<string, SshRunner>();
	const sessionKey = (ctx: any): string => {
		const id = ctx.sessionManager?.getSessionId();
		if (typeof id !== "string" || !id) throw new Error("SSH requires a session identity.");
		return id;
	};
	pi.registerTool({
		name: "git", label: "Git / Forge CLI",
		description: "Run git, gh, or tea with direct arguments and inherited credentials; git is the default. No local shell expansion. "
			+ "This tool does not grant consent: obtain explicit user approval before commits, pushes, destructive Git operations or issue changes; show exact issue text before publication. "
			+ "Never request credential output. Host aliases, hooks, helpers and forge extensions can execute local commands. "
			+ "Capture is limited to 1 MiB; displayed output to 2000 lines or 50 KB. Unsandboxed by default on new configurations; saved exceptions still apply.",
		parameters: { type: "object", properties: { program: { type: "string", enum: ["git", "gh", "tea"], description: "Default: git." }, args: argv, cwd, timeout }, required: ["args"], additionalProperties: false },
		async execute(_id, params: any, signal, _update, ctx) {
			const response = await runGit(pi.exec.bind(pi), params, ctx.cwd, signal);
			return result([response.stdout, response.stderr, `Exit code: ${response.code}`,
				response.killed ? "The process was terminated." : "",
				response.truncated ? "Capture exceeded 1 MiB. Narrow the command output." : "",
			].filter(Boolean).join("\n"), { code: response.code, killed: response.killed, truncated: response.truncated }, response.code !== 0 || response.killed);
		},
	} as any);
	pi.registerTool({
		name: "ssh", label: "SSH",
		description: "Run OpenSSH using the current user's config, keys, agent and known_hosts. Supply native ssh args: host aliases, remote commands, -J jump hosts, -L/-R forwards, -D SOCKS proxy, -W stdio forwarding, -N tunnel. "
			+ "action run waits (default 60s); start returns a managed process ID, not proof of connection or a bound port. Use status/list for bounded output and stop to close it. "
			+ "No interactive terminal or password prompts; no daemonization or control of unrelated SSH masters. Connections close on session shutdown/reload. "
			+ "Remote command arguments use the remote SSH shell semantics. Configured ProxyCommand and other helpers can execute local commands. "
			+ "Never request credentials or weaken host-key checking. Unsandboxed by default on new configurations; saved exceptions still apply. Capture per process is 1 MiB; displayed output 2000 lines or 50 KB.",
		parameters: { type: "object", properties: {
			action: { type: "string", enum: ["run", "start", "list", "status", "stop"], description: "Default run. start manages a background connection until stopped, timeout or session shutdown." },
			args: argv, id: { type: "string", description: "Process ID returned by start; required for status/stop." }, cwd, timeout,
		}, additionalProperties: false },
		executionMode: "sequential",
		async execute(_id, params: any, signal, _update, ctx) {
			const key = sessionKey(ctx);
			let manager = sessions.get(key);
			if (!manager) { manager = new SshRunner(); sessions.set(key, manager); }
			const response = await manager.execute(params, ctx.cwd, signal);
			if (Array.isArray(response)) {
				// List metadata only: output from 64 retained processes must not
				// leak into details or overwhelm the model. Use status for output.
				const processes = response.map(({ stdout: _out, stderr: _err, ...item }) => item);
				return result(JSON.stringify(processes, null, 2), { processes });
			}
			const { stdout, stderr, ...metadata } = response;
			const inspection = params.action === "status" || params.action === "stop";
			const failed = !inspection && (Boolean(response.error) || (response.state === "exited" && response.code !== 0) || response.timedOut);
			return result([JSON.stringify(metadata, null, 2), stdout, stderr].filter(Boolean).join("\n"), metadata, failed);
		},
	} as any);
	pi.on("session_shutdown", async (_event, ctx) => {
		const key = sessionKey(ctx);
		const manager = sessions.get(key);
		if (manager) { sessions.delete(key); await manager.close(); }
	});
}
