import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SshInput {
	action?: "run" | "start" | "list" | "status" | "stop";
	args?: string[];
	id?: string;
	cwd?: string;
	timeout?: number;
}

export interface SshSnapshot {
	id: string;
	state: "running" | "exited";
	pid?: number;
	code?: number | null;
	signal?: string | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	stopped: boolean;
	error?: string;
}

interface SshRunnerOptions {
	/** Test seam only; execute always requests the native ssh executable. */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

interface Entry {
	view: SshSnapshot;
	child?: ChildProcess;
	output?: Buffer;
	streams?: Uint8Array;
	position: number;
	bytes: number;
	done: Promise<void>;
	resolve: () => void;
	spawned: Promise<void>;
	resolveSpawned: () => void;
	closed: boolean;
	cleanupStarted: boolean;
	cleanupDone: boolean;
	finished: boolean;
	timers: Set<ReturnType<typeof setTimeout>>;
	detachAbort?: () => void;
	dispose?: () => void;
}

const OUTPUT_LIMIT = 1024 * 1024;
const ACTIVE_LIMIT = 16;
const RETAINED_LIMIT = 64;
const DEFAULT_OPTIONS = [
	"-oBatchMode=yes", "-T", "-oRequestTTY=no", "-oForkAfterAuthentication=no",
	"-oControlMaster=no", "-oControlPath=none",
];

function validateArgs(args: string[]): void {
	// OpenSSH parses options both before and immediately after the destination.
	// Only -- or the first remote-command word ends local option parsing.
	const takesValue = "BbcDEeFIiJLlmOoPpQRSWw";
	let destination = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") {
			if (destination) break;
			destination = true;
			continue;
		}
		for (let offset = 1; offset < arg.length; offset++) {
			const flag = arg[offset];
			if ("ftMSO".includes(flag)) throw new Error(`SSH option -${flag} is not managed safely`);
			if (!takesValue.includes(flag)) continue;
			const value = arg.slice(offset + 1) || args[++index];
			if (value === undefined) throw new Error(`SSH option -${flag} requires a value`);
			if (flag === "o") {
				const match = /^\s*([^\s=]+)[\s=]+(.*?)\s*$/.exec(value.replace(/^=/, ""));
				if (match) {
					const key = match[1].toLowerCase();
					const setting = match[2].replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
					const safe: Record<string, string[]> = {
						forkafterauthentication: ["no"], requesttty: ["no"],
						controlmaster: ["no"], controlpath: ["none"], controlpersist: ["no", "0"],
						batchmode: ["yes"],
					};
					if (key in safe && !safe[key].includes(setting)) throw new Error(`SSH option ${match[1]} conflicts with managed execution`);
				}
			}
			break;
		}
	}
}

/** Owns noninteractive SSH children, their process groups, and bounded output/history. */
export class SshRunner {
	private readonly spawn: NonNullable<SshRunnerOptions["spawn"]>;
	private readonly entries = new Map<string, Entry>();
	private closing?: Promise<void>;

	constructor(options: SshRunnerOptions = {}) {
		this.spawn = options.spawn ?? nodeSpawn;
	}

	async execute(input: SshInput, defaultCwd: string, signal?: AbortSignal): Promise<SshSnapshot | SshSnapshot[]> {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SSH input must be an object");
		const action = input.action === undefined ? "run" : input.action;
		if (!["run", "start", "list", "status", "stop"].includes(action)) throw new Error("Invalid SSH action");
		const launch = action === "run" || action === "start";
		if (launch ? input.id !== undefined : action === "list" ? input.id !== undefined : typeof input.id !== "string" || !input.id || input.id.includes("\0")) {
			throw new Error("Only status/stop require an id");
		}
		if (!launch && (input.args !== undefined || input.cwd !== undefined || input.timeout !== undefined)) throw new Error("args, cwd and timeout require run/start");
		if (!launch) {
			if (action === "list") return [...this.entries.values()].map((entry) => this.snapshot(entry));
			const entry = this.entries.get(input.id!);
			if (!entry) throw new Error(`Unknown SSH id: ${input.id}`);
			if (action === "stop" && !entry.finished) {
				entry.view.stopped = true;
				this.terminate(entry);
				await entry.done;
			}
			return this.snapshot(entry);
		}
		const args = input.args === undefined ? [] : input.args;
		if (!Array.isArray(args) || Array.from(args).some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("SSH args must be strings without NUL");
		const cwd = input.cwd === undefined ? defaultCwd : input.cwd;
		if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) throw new Error("SSH cwd must be a nonempty path without NUL");
		if (input.timeout !== undefined && (!Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > 600)) throw new Error("SSH timeout must be an integer from 1 to 600 seconds");
		validateArgs(args);
		if (this.closing) throw new Error("SSH runner is closed");
		if (signal?.aborted) throw new Error("SSH execution aborted");
		if ([...this.entries.values()].filter((entry) => !entry.finished).length >= ACTIVE_LIMIT) throw new Error("SSH active process limit (16) reached");
		while (this.entries.size >= RETAINED_LIMIT) {
			const oldest = [...this.entries.values()].find((entry) => entry.finished);
			if (!oldest) break;
			this.entries.delete(oldest.view.id);
		}
		let resolve!: () => void;
		let resolveSpawned!: () => void;
		const entry: Entry = {
			view: { id: randomUUID(), state: "running", stdout: "", stderr: "", truncated: false, timedOut: false, stopped: false },
			position: 0, bytes: 0, done: new Promise((done) => { resolve = done; }), resolve: () => resolve(),
			spawned: new Promise((done) => { resolveSpawned = done; }), resolveSpawned: () => resolveSpawned(),
			closed: false, cleanupStarted: false, cleanupDone: false, finished: false, timers: new Set(),
		};
		this.entries.set(entry.view.id, entry);
		try {
			const child = this.spawn("ssh", [...DEFAULT_OPTIONS, ...args], {
				cwd, env: process.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
			});
			entry.child = child;
			entry.view.pid = child.pid;
			const stdout = (data: Buffer) => this.capture(entry, 0, data);
			const stderr = (data: Buffer) => this.capture(entry, 1, data);
			const spawned = () => entry.resolveSpawned();
			const error = (error: Error) => {
				entry.view.error = error.message;
				entry.resolveSpawned();
				this.terminate(entry);
			};
			const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
				entry.view.state = "exited";
				entry.view.code = code;
				entry.view.signal = exitSignal;
				// A proxy/helper may still hold our pipes after the SSH leader exits.
				this.terminate(entry);
			};
			const closed = (code: number | null, exitSignal: NodeJS.Signals | null) => {
				exited(code, exitSignal);
				entry.closed = true;
				entry.resolveSpawned();
				this.finish(entry);
			};
			child.stdout?.on("data", stdout);
			child.stderr?.on("data", stderr);
			child.stdout?.on("error", error);
			child.stderr?.on("error", error);
			child.once("spawn", spawned);
			child.once("error", error);
			child.once("exit", exited);
			child.once("close", closed);
			entry.dispose = () => {
				child.stdout?.removeListener("data", stdout);
				child.stderr?.removeListener("data", stderr);
				child.stdout?.removeListener("error", error);
				child.stderr?.removeListener("error", error);
				child.removeListener("spawn", spawned);
				child.removeListener("error", error);
				child.removeListener("exit", exited);
				child.removeListener("close", closed);
			};
			const timeout = input.timeout ?? (action === "run" ? 60 : undefined);
			if (timeout !== undefined) this.timer(entry, () => {
				entry.view.timedOut = true;
				this.terminate(entry);
			}, timeout * 1000);
			if (signal) {
				const abort = () => { entry.view.stopped = true; entry.view.error = "SSH execution aborted"; this.terminate(entry); };
				signal.addEventListener("abort", abort, { once: true });
				entry.detachAbort = () => signal.removeEventListener("abort", abort);
				if (signal.aborted) abort();
			}
		} catch (error) {
			entry.view.error = error instanceof Error ? error.message : String(error);
			entry.closed = entry.cleanupDone = true;
			entry.resolveSpawned();
			this.finish(entry);
		}
		await entry.spawned;
		if (action === "start") {
			entry.detachAbort?.();
			entry.detachAbort = undefined;
			if (entry.view.stopped || entry.view.error) await entry.done;
		} else await entry.done;
		return this.snapshot(entry);
	}

	async close(): Promise<void> {
		if (!this.closing) {
			this.closing = Promise.all([...this.entries.values()].map(async (entry) => {
				if (!entry.finished) { entry.view.stopped = true; this.terminate(entry); }
				await entry.done;
			})).then(() => undefined);
		}
		await this.closing;
	}

	private snapshot(entry: Entry): SshSnapshot {
		const stdout = Buffer.allocUnsafe(entry.bytes);
		const stderr = Buffer.allocUnsafe(entry.bytes);
		let out = 0;
		let err = 0;
		const start = (entry.position - entry.bytes + OUTPUT_LIMIT) % OUTPUT_LIMIT;
		for (let offset = 0; offset < entry.bytes; offset++) {
			const index = (start + offset) % OUTPUT_LIMIT;
			if (entry.streams![index] === 0) stdout[out++] = entry.output![index];
			else stderr[err++] = entry.output![index];
		}
		return { ...entry.view, stdout: stdout.toString("utf8", 0, out), stderr: stderr.toString("utf8", 0, err) };
	}

	private capture(entry: Entry, stream: number, data: Buffer): void {
		if (entry.finished || !data.length) return;
		// Fixed-size rings also bound metadata when a child emits many tiny writes.
		entry.output ??= Buffer.allocUnsafe(OUTPUT_LIMIT);
		entry.streams ??= new Uint8Array(OUTPUT_LIMIT);
		if (entry.bytes + data.length > OUTPUT_LIMIT) entry.view.truncated = true;
		const retained = data.subarray(Math.max(0, data.length - OUTPUT_LIMIT));
		const position = (entry.position + data.length - retained.length) % OUTPUT_LIMIT;
		const first = Math.min(retained.length, OUTPUT_LIMIT - position);
		retained.copy(entry.output, position, 0, first);
		entry.streams.fill(stream, position, position + first);
		if (first < retained.length) {
			retained.copy(entry.output, 0, first);
			entry.streams.fill(stream, 0, retained.length - first);
		}
		entry.position = (entry.position + data.length) % OUTPUT_LIMIT;
		entry.bytes = Math.min(OUTPUT_LIMIT, entry.bytes + data.length);
	}

	private timer(entry: Entry, callback: () => void, delay: number): void {
		const timer = setTimeout(() => { entry.timers.delete(timer); callback(); }, delay);
		entry.timers.add(timer);
	}

	private kill(entry: Entry, signal: NodeJS.Signals): void {
		if (!entry.child?.pid) return;
		try {
			if (process.platform === "win32") entry.child.kill(signal);
			else process.kill(-entry.child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") entry.view.error ??= `SSH cleanup failed: ${String(error)}`;
		}
	}

	private terminate(entry: Entry): void {
		if (entry.cleanupStarted || entry.finished) return;
		entry.cleanupStarted = true;
		for (const timer of entry.timers) clearTimeout(timer);
		entry.timers.clear();
		entry.detachAbort?.();
		entry.detachAbort = undefined;
		this.kill(entry, "SIGTERM");
		if (!entry.child?.pid) {
			entry.cleanupDone = true;
			this.finish(entry);
			return;
		}
		this.timer(entry, () => {
			this.kill(entry, "SIGKILL");
			entry.cleanupDone = true;
			this.finish(entry);
			if (!entry.finished) this.timer(entry, () => {
				entry.view.error ??= "SSH pipes did not close after termination";
				entry.child?.stdout?.destroy();
				entry.child?.stderr?.destroy();
				entry.closed = true;
				this.finish(entry);
			}, 1000);
		}, 250);
	}

	private finish(entry: Entry): void {
		if (entry.finished || !entry.closed || !entry.cleanupDone) return;
		entry.finished = true;
		entry.view.state = "exited";
		for (const timer of entry.timers) clearTimeout(timer);
		entry.timers.clear();
		entry.detachAbort?.();
		entry.detachAbort = undefined;
		entry.dispose?.();
		entry.dispose = undefined;
		entry.child = undefined;
		entry.resolve();
	}
}
