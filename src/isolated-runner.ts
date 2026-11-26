import { handleModelRelay } from "./model-relay.ts";
import type { FilesystemMode } from "./types.ts";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiToolBridge } from "./bridge.ts";
import type { BridgeResult, OpenAITool, RpcRecord } from "./bridge.ts";
import { buildIsolatedLaunch } from "./isolated-launcher.ts";

export interface IsolatedRunnerOptions {
	cwd: string;
	extensions: string[];
	filesystem: FilesystemMode;
	paths: string[];
	/** Host directories that the sandbox mounts at the same path. */
	mounts?: ReadonlyArray<{ path: string; writable: boolean }>;
	/** True isolates the network namespace. False keeps the host network. The caller always passes it. */
	network: boolean;
	piPath?: string;
	nodePath?: string;
	/** The host Pi agent directory. Undefined mounts none. */
	piAgentDir?: string;
	/** The pi-subagents run directory that the sandbox shares with this host. */
	subagentsRoot?: string;
	timeoutMs?: number;
	streamModel?: (context: any, signal: AbortSignal, options?: any) => AsyncIterable<any>;
	approve?: (event: any, signal: AbortSignal) => Promise<any>;
	onUI?: (request: RpcRecord) => Promise<void | RpcRecord>;
}

/** One inner tool: its source file and the exposure that the inner Pi reported. */
export interface InnerTool {
	path: string;
	exposure?: unknown;
}

/** One persistent inner Pi. Calls are serialized by the outer extension. */
export class IsolatedRunner {
	readonly bridge: PiToolBridge;
	readonly inventory = new Map<string, InnerTool>();
	private child?: ChildProcessWithoutNullStreams;
	private server: Server;
	private directory?: string;
	private stderr = "";
	private closed = false;
	private options: IsolatedRunnerOptions;
	private constructor(options: IsolatedRunnerOptions) {
		this.options = options;
		this.bridge = new PiToolBridge({
			token: randomBytes(32).toString("hex"), timeoutMs: options.timeoutMs ?? 120_000,
			maxBodyBytes: 32 * 1024 * 1024,
			send: (record) => this.send(record), onUI: async (record) => {
				if (record.method === "notify" && typeof record.message === "string") {
					try {
						const data = JSON.parse(record.message);
						if (data.piToolsetInventory === 1 && Array.isArray(data.tools)) {
							this.inventory.clear();
							for (const tool of data.tools) {
								if (typeof tool.name === "string" && typeof tool.sourceInfo?.path === "string") this.inventory.set(tool.name, { path: tool.sourceInfo.path, exposure: tool.exposure });
							}
							return;
						}
					} catch { /* Ordinary extension notification. */ }
				}
				return options.onUI?.(record);
			},
		});
		this.server = createServer((req, res) => {
			if (req.url === "/model" || req.url === "/permissions") void handleModelRelay(req, res, this.bridge.token, options.streamModel, options.approve);
			else void this.bridge.handleRequest(req, res);
		});
	}

	static async start(options: IsolatedRunnerOptions): Promise<{ runner: IsolatedRunner; tools: OpenAITool[]; skipped: string[] }> {
		const runner = new IsolatedRunner(options);
		try {
			const skipped = await runner.launch();
			return { runner, tools: await runner.bridge.discover(), skipped };
		} catch (error) {
			await runner.close();
			throw error;
		}
	}

	/** Starts the inner process. Returns the host paths that the sandbox could not show. */
	private async launch(): Promise<string[]> {
		this.directory = await mkdtemp(join(tmpdir(), "pi-tool-bridge-"));
		const socketPath = join(this.directory, "model.sock");
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(socketPath, () => { this.server.removeListener("error", reject); resolve(); });
		});
		this.server.on("error", (error) => this.bridge.fail(error));
		const plan = buildIsolatedLaunch({
			socketPath, token: this.bridge.token,
			cwd: this.options.cwd, extensions: this.options.extensions,
			filesystem: this.options.filesystem, paths: this.options.paths, mounts: this.options.mounts, network: this.options.network,
			piPath: this.options.piPath, nodePath: this.options.nodePath, piAgentDir: this.options.piAgentDir,
			subagentsRoot: this.options.subagentsRoot,
		});
		const child = spawn(plan.command, plan.args, { cwd: this.options.cwd, env: plan.env, stdio: "pipe" });
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.bridge.feed(chunk));
		child.stdout.on("end", () => this.bridge.fail(new Error(`Inner Pi closed its output. ${this.stderr}`)));
		child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192); });
		// A write to a child that already exited reports EPIPE on the stream. The exit handler
		// reports the real cause, so the stream error only needs a listener.
		child.stdin.on("error", (error) => { this.bridge.fail(new Error(`Inner Pi input failed: ${error.message}. ${this.stderr}`)); });
		child.on("error", (error) => this.bridge.fail(error));
		child.on("exit", (code, signal) => {
			this.bridge.fail(new Error(`Inner Pi exited (${signal ?? code}). ${this.stderr}`));
		});
		return plan.skipped;
	}

	private send(record: RpcRecord): Promise<void> {
		const child = this.child;
		if (!child || child.stdin.destroyed || this.closed) return Promise.reject(new Error("Inner Pi is unavailable."));
		return new Promise((resolve, reject) => {
			child.stdin.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolve());
		});
	}

	execute(name: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void): Promise<BridgeResult> {
		return this.bridge.execute(name, args, signal, onUpdate);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.bridge.close();
		const child = this.child;
		if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
				const deadline = setTimeout(resolve, 3000);
				child.once("exit", () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
				child.stdin.end();
				child.kill("SIGTERM");
			});
		}
		this.server.closeAllConnections();
		if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
	}
}
