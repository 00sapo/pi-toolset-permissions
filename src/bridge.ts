import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

export type RpcRecord = Record<string, any>;
export interface OpenAITool {
	type: "function";
	function: { name: string; description?: string; parameters: Record<string, unknown>; [key: string]: unknown };
	[key: string]: unknown;
}
export interface BridgeResult { result: unknown; isError: boolean }
export interface BridgeOptions {
	token: string;
	send: (record: RpcRecord) => void | Promise<void>;
	onUI?: (request: RpcRecord) => void | RpcRecord | Promise<void | RpcRecord>;
	timeoutMs?: number;
	maxBodyBytes?: number;
}
interface Pending {
	kind: "discover" | "execute";
	id: string;
	callId: string;
	name?: string;
	args?: unknown;
	arguments?: string;
	emitted: boolean;
	started: boolean;
	metadata?: OpenAITool[];
	output?: BridgeResult;
	onUpdate?: (result: unknown) => void;
	children: Map<string, string>;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
	/** User dialogs can take longer than the protocol timeout. */
	pauseTimer: () => void;
	resumeTimer: () => void;
}

/** The host owns the HTTP server and child process. No SDK or model connection is used. */
export class PiToolBridge {
	private readonly options: BridgeOptions;
	private readonly timeoutMs: number;
	private readonly maxBodyBytes: number;
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private pending?: Pending;
	private poisoned?: Error;
	private tools?: OpenAITool[];
	private readingRequest = false;
	private cancelRead?: (error: Error) => void;

	constructor(options: BridgeOptions) {
		if (!options.token) throw new Error("A bearer token is required");
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Invalid timeout");
		if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) throw new Error("Invalid body limit");
		this.options = options;
	}

	get token(): string { return this.options.token; }

	feed(chunk: Uint8Array | string): void { this.onData(chunk); }

	discover(signal?: AbortSignal): Promise<OpenAITool[]> {
		return this.begin("discover", undefined, undefined, signal);
	}

	execute(name: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void): Promise<BridgeResult> {
		return this.begin("execute", name, args, signal, onUpdate);
	}

	private begin(kind: Pending["kind"], name?: string, args?: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void): Promise<any> {
		if (this.poisoned) return Promise.reject(this.poisoned);
		if (this.pending) return Promise.reject(new Error("Bridge is busy"));
		if (kind === "execute" && !this.tools?.some((tool) => tool.function.name === name)) {
			return Promise.reject(new Error(`Unknown tool: ${name}`));
		}
		let serialized: string | undefined;
		try {
			if (kind === "execute") {
				serialized = JSON.stringify(args);
				if (!serialized || args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
				args = JSON.parse(serialized);
			}
		} catch (error) { return Promise.reject(error); }
		return new Promise((resolve, reject) => {
			const abort = () => this.fail(new Error("Bridge operation aborted"));
			let timer: ReturnType<typeof setTimeout> | undefined;
			const startTimer = () => { timer = setTimeout(() => this.fail(new Error("Bridge operation timeout")), this.timeoutMs); };
			startTimer();
			this.pending = {
				kind, name, args, arguments: serialized, id: randomUUID(), callId: `bridge_${randomUUID()}`,
				emitted: false, started: false, children: new Map(), onUpdate, resolve, reject,
				cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); },
				pauseTimer: () => { if (timer) clearTimeout(timer); timer = undefined; },
				resumeTimer: () => { if (!timer && !this.poisoned) startTimer(); },
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) { abort(); return; }
			this.send({ type: "prompt", id: this.pending.id, message: "Perform the bridge operation." });
		});
	}

	private send(record: RpcRecord): void {
		try {
			const sent = this.options.send(record);
			if (sent) void Promise.resolve(sent).catch((error) => this.fail(error));
		} catch (error) { this.fail(error); }
	}

	/** Feed raw child stdout chunks here. Only LF terminates a record. */
	onData(chunk: Uint8Array | string): void {
		if (this.poisoned) return;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		let index: number;
		while (!this.poisoned && (index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (Buffer.byteLength(line) > this.maxBodyBytes) { this.fail(new Error("RPC record exceeds body limit")); return; }
			try { this.onRecord(JSON.parse(line)); }
			catch (error) { this.fail(error); }
		}
		if (Buffer.byteLength(this.buffer) > this.maxBodyBytes) this.fail(new Error("RPC record exceeds body limit"));
	}

	/** Feed decoded RPC objects here instead of onData when the host owns framing. */
	onRecord(record: RpcRecord): void {
		if (this.poisoned) return;
		if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
			this.fail(new Error("Invalid RPC record")); return;
		}
		if (record.type === "extension_ui_request") {
			void this.handleUI(record);
			return;
		}
		const p = this.pending;
		if (record.type.startsWith("tool_execution_")) {
			this.toolEvent(record, p);
			return;
		}
		if (!p) return;
		if (record.type === "response" && record.success === false && (record.id === p.id || record.id == null)) {
			this.fail(new Error(`RPC failure: ${record.error ?? "Unknown error"}`)); return;
		}
		if (record.type === "response" && record.id === p.id && record.success === true && record.data?.disposition && record.data.disposition !== "started") {
			this.fail(new Error(`Prompt did not start: ${record.data.disposition}`)); return;
		}
		const message = record.message;
		if ((record.type === "message_end" || record.type === "turn_end") && message?.role === "assistant" && ["error", "aborted"].includes(message.stopReason)) {
			this.fail(new Error(`Provider failure: ${message.errorMessage ?? message.stopReason}`)); return;
		}
		if (record.type === "message_update" && record.assistantMessageEvent?.type === "error") {
			this.fail(new Error(`Provider failure: ${record.assistantMessageEvent.error?.errorMessage ?? record.assistantMessageEvent.reason ?? "Unknown error"}`)); return;
		}
		if (record.type === "extension_error" || (record.type === "auto_retry_end" && record.success === false)) {
			this.fail(new Error(`RPC failure: ${record.error ?? record.finalError ?? "Extension error"}`)); return;
		}
		if (record.type !== "agent_settled") return;
		if (record.aborted) { this.fail(new Error("Agent aborted")); return; }
		if (p.kind === "discover" ? !p.metadata : !p.output) {
			this.fail(new Error("Agent settled without the expected model request or tool result")); return;
		}
		if (p.children.size) { this.fail(new Error("Agent settled with unfinished nested tools")); return; }
		p.cleanup();
		this.pending = undefined;
		if (p.kind === "discover") {
			this.tools = structuredClone(p.metadata!);
			p.resolve(structuredClone(p.metadata!));
		} else p.resolve(p.output);
	}

	private toolEvent(record: RpcRecord, p?: Pending): void {
		const unexpected = () => this.fail(new Error("Unexpected or unsolicited tool execution"));
		if (!p || p.kind !== "execute" || !p.emitted) { unexpected(); return; }
		const { toolCallId: id, parentToolCallId: parent, type } = record;
		if (parent !== undefined) {
			if (typeof id !== "string" || !id || id === p.callId || typeof parent !== "string") { unexpected(); return; }
			if (type === "tool_execution_start") {
				if (!p.started || p.output || p.children.has(id) || (parent !== p.callId && !p.children.has(parent))) { unexpected(); return; }
				p.children.set(id, parent);
			} else {
				if (p.children.get(id) !== parent) { unexpected(); return; }
				if (type === "tool_execution_end") p.children.delete(id);
			}
			return;
		}
		if (id !== p.callId || record.toolName !== p.name) { unexpected(); return; }
		if (type === "tool_execution_start") {
			if (p.started || !isDeepStrictEqual(record.args, p.args)) { unexpected(); return; }
			p.started = true;
		} else if (!p.started || p.output) unexpected();
		else if (type === "tool_execution_update") {
			try { p.onUpdate?.(record.partialResult); } catch (error) { this.fail(error); }
		} else if (type === "tool_execution_end") {
			if (!("result" in record) || typeof record.isError !== "boolean") { unexpected(); return; }
			p.output = { result: record.result, isError: record.isError };
		}
	}

	private async handleUI(record: RpcRecord): Promise<void> {
		const p = this.pending;
		const dialog = ["select", "confirm", "input", "editor"].includes(record.method);
		if (dialog) p?.pauseTimer();
		try {
			const reply = await this.options.onUI?.(record);
			if (this.poisoned) return;
			if (["select", "confirm", "input", "editor"].includes(record.method)) {
				this.send({ ...(reply ?? { cancelled: true }), type: "extension_ui_response", id: record.id });
			}
		} catch (error) { this.fail(error); }
		finally { if (dialog) this.pending?.resumeTimer(); }
	}

	/** Bound handler is suitable for http.createServer(bridge.handleRequest). */
	handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const reject = (status: number, message: string) => {
			res.statusCode = status;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: { message } }));
		};
		const auth = Buffer.from(req.headers.authorization ?? "");
		const expected = Buffer.from(`Bearer ${this.options.token}`);
		if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { reject(401, "Unauthorized"); return; }
		if (req.url !== "/v1/chat/completions") { reject(404, "Not found"); return; }
		if (req.method !== "POST") { reject(405, "POST required"); return; }
		const p = this.pending;
		if (this.poisoned || !p) { reject(409, "No active bridge operation"); return; }
		if (this.readingRequest || (p.emitted && (p.kind === "discover" || !p.output))) {
			reject(409, "Unexpected duplicate model request");
			this.fail(new Error("Unexpected duplicate model request")); return;
		}
		this.readingRequest = true;
		try {
			const body = await new Promise<Buffer>((resolve, rejectBody) => {
				const chunks: Buffer[] = [];
				let size = 0;
				const cleanup = () => {
					this.cancelRead = undefined;
					req.removeListener("data", data); req.removeListener("end", end);
					req.removeListener("error", error); req.removeListener("aborted", aborted);
				};
				const error = (error: Error) => { cleanup(); rejectBody(error); };
				this.cancelRead = error;
				const aborted = () => error(new Error("HTTP body aborted"));
				const data = (chunk: Buffer | string) => {
					const bytes = Buffer.from(chunk);
					size += bytes.length;
					if (size > this.maxBodyBytes) { error(new Error("HTTP body exceeds limit")); return; }
					chunks.push(bytes);
				};
				const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
				req.on("data", data); req.on("end", end); req.on("error", error); req.on("aborted", aborted);
			});
			if (this.poisoned || this.pending !== p) { reject(409, "Bridge operation ended"); return; }
			const input = JSON.parse(body.toString("utf8"));
			if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid JSON request body");
			if (!p.emitted) {
				if (p.kind === "discover" && input.tools === undefined) input.tools = [];
				if (!Array.isArray(input.tools)) throw new Error("Model request must include tools");
				const names = new Set<string>();
				for (const tool of input.tools) {
					if (tool?.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name || !tool.function.parameters || typeof tool.function.parameters !== "object" || Array.isArray(tool.function.parameters) || names.has(tool.function.name)) {
						throw new Error("Invalid or duplicate tool definition");
					}
					names.add(tool.function.name);
				}
				if (p.kind === "discover") p.metadata = input.tools;
				else if (!names.has(p.name!)) throw new Error(`Unknown tool in model request: ${p.name}`);
			}
			const emitCall = p.kind === "execute" && !p.emitted;
			p.emitted = true;
			const delta = emitCall ? { role: "assistant", tool_calls: [{ index: 0, id: p.callId, type: "function", function: { name: p.name, arguments: p.arguments } }] } : { role: "assistant", content: "" };
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			const chunk = { id: `chatcmpl-${randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: typeof input.model === "string" ? input.model : "pi-tool-bridge", choices: [{ index: 0, delta, finish_reason: emitCall ? "tool_calls" : "stop" }] };
			res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			reject(message.includes("exceeds limit") ? 413 : 400, message);
			this.fail(new Error(`HTTP JSON body failure: ${message}`));
		} finally { this.readingRequest = false; }
	};

	/** Report startup errors, stdout EOF, or child exit here. Failure is permanent. */
	fail(error: unknown): void {
		if (this.poisoned) return;
		this.poisoned = error instanceof Error ? error : new Error(String(error));
		const p = this.pending;
		this.pending = undefined;
		this.buffer = "";
		p?.cleanup();
		p?.reject(this.poisoned);
		this.cancelRead?.(this.poisoned);
		this.send({ type: "abort", id: randomUUID() });
	}

	close(): void { this.fail(new Error("Bridge closed")); }
}
