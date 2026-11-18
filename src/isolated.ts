import type { ExtensionAPI, ExtensionContext, Tool } from "@earendil-works/pi-coding-agent";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { IsolatedRunner } from "./isolated-runner.ts";
import { forwardBridgeUI } from "./bridge-ui.ts";
import { StateStore } from "./state.ts";
import { foreignTools, layerKey, layersActive } from "./layers.ts";
import type { SandboxLayers } from "./layers.ts";

/**
 * Opt-in entry point. Every built-in tool name becomes a delegate. With no layer the delegate
 * calls the host implementation. With a layer on it calls an isolated Pi, so a call never
 * reaches the host filesystem or network while a layer is on.
 */
export default function isolatedExtension(pi: ExtensionAPI): void {
	if (process.env.PI_TOOLSET_INNER === "1") throw new Error("The isolated entry point cannot load inside its own child.");
	const store = new StateStore();
	const ownPath = fileURLToPath(import.meta.url);
	let runner: IsolatedRunner | undefined;
	let runnerKey: string | undefined;
	let starting: Promise<void> | undefined;
	let currentContext: ExtensionContext | undefined;
	let currentSignal: AbortSignal | undefined;
	let shadows: Map<string, Tool> | undefined;
	let wired = false;
	let registered = false;

	pi.registerFlag("inner-extensions", { type: "string", description: "JSON array of extension paths to load only inside the sandbox.", default: "[]" });
	pi.registerFlag("inner-pi", { type: "string", description: "Absolute path to the inner Pi executable." });
	pi.registerFlag("inner-node", { type: "string", description: "Absolute path to Node.js 22.19 or newer." });

	function extensionPaths(): string[] {
		const value: unknown = JSON.parse(String(pi.getFlag("inner-extensions") ?? "[]"));
		if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path)) {
			throw new Error("--inner-extensions needs a JSON array of file paths.");
		}
		return value as string[];
	}

	function status(text: string | undefined): void {
		try {
			currentContext?.ui.setStatus("isolated", text);
		} catch {
			// The footer is cosmetic.
		}
	}

	function hostTools(cwd: string): Tool[] {
		if (!shadows) shadows = new Map(createCodingTools(cwd).map((tool) => [tool.name, tool]));
		return [...shadows.values()];
	}

	async function stopRunner(): Promise<void> {
		const current = runner;
		runner = undefined;
		runnerKey = undefined;
		if (current) await current.close();
	}

	/** The running executor for these layers. It starts one if the combination needs it. */
	async function ensureRunner(ctx: ExtensionContext, layers: SandboxLayers): Promise<IsolatedRunner | undefined> {
		if (!layersActive(layers)) {
			if (runner || starting) {
				await (starting ?? Promise.resolve());
				await stopRunner();
			}
			status(undefined);
			return undefined;
		}
		const key = layerKey(layers);
		if (runner && runnerKey === key) return runner;
		if (starting) {
			await starting;
			return runnerKey === key ? runner : ensureRunner(ctx, layers);
		}
		status(`isolated:starting ${key}`);
		starting = (async () => {
			try {
				await stopRunner();
				const foreign = foreignTools(ownPath, pi.getAllTools());
				if (foreign.length) {
					throw new Error(
						`Third-party tools load in the host process: ${foreign.join(", ")}. Start the outer Pi with --no-extensions and pass their paths with --inner-extensions.`,
					);
				}
				const started = await IsolatedRunner.start({
					cwd: ctx.cwd,
					extensions: extensionPaths().map((path) => resolve(ctx.cwd, path)),
					readonly: layers.readonly_bash,
					network: layers.no_network,
					piPath: pi.getFlag("inner-pi") as string | undefined,
					nodePath: pi.getFlag("inner-node") as string | undefined,
					onUI: async (request) => {
						if (!currentContext) throw new Error("The outer UI is unavailable.");
						return forwardBridgeUI(request, currentContext.ui, currentSignal);
					},
				});
				// The layers can change while the process starts.
				if (layerKey(store.get().sandboxes) !== key) {
					await started.runner.close();
					return;
				}
				runner = started.runner;
				runnerKey = key;
				status(`isolated:${key} ${started.tools.length} tools`);
			} catch (error) {
				await stopRunner();
				status(`isolated:failed ${error instanceof Error ? error.message : String(error)}`);
				ctx.ui.notify(`The isolated executor is off: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				starting = undefined;
			}
		})();
		await starting;
		return runnerKey === key ? runner : undefined;
	}

	/** A layer is on, so a missing executor is an error and never a fallback to the host. */
	async function runIsolated(ctx: ExtensionContext, name: string, args: unknown, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined) {
		const active = await ensureRunner(ctx, { ...store.get().sandboxes });
		if (!active) throw new Error("The isolated executor is not running. Turn the sandbox layers off and on again, then retry the call.");
		const response = await active.execute(name, args, signal, onUpdate);
		return { ...(response.result as any), isError: response.isError };
	}

	async function dispatch(tool: Tool, id: any, params: any, signal: any, onUpdate: any, ctx: any) {
		currentContext = ctx;
		try {
			store.reload();
		} catch {
			// An unreadable file keeps the last good state.
		}
		const layers = { ...store.get().sandboxes };
		if (!layersActive(layers)) return (tool.execute as any)(id, params, signal, onUpdate, ctx);
		currentSignal = signal;
		try {
			return await runIsolated(ctx, tool.name, params, signal, onUpdate);
		} finally {
			currentSignal = undefined;
		}
	}

	pi.on("tool_call", (event, ctx) => {
		currentContext = ctx;
		let layers: SandboxLayers;
		try {
			store.reload();
			layers = { ...store.get().sandboxes };
		} catch {
			layers = { ...store.get().sandboxes };
		}
		// A changed combination restarts the process now, so this call waits instead of failing.
		if (layersActive(layers) && runnerKey !== layerKey(layers)) void ensureRunner(ctx, layers);
		return undefined;
	});

	function register(cwd: string): void {
		if (registered) return;
		registered = true;
		for (const tool of hostTools(cwd)) {
			pi.registerTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				executionMode: "sequential",
				execute: (id, params, signal, onUpdate, ctx) => dispatch(tool, id, params, signal, onUpdate, ctx),
			});
		}
	}

	pi.on("session_start", async (event, ctx) => {
		currentContext = ctx;
		if (event.reason !== "reload") registered = false;
		register(ctx.cwd);
		if (!wired) {
			wired = true;
			store.onChange(() => {
				if (currentContext) void ensureRunner(currentContext, { ...store.get().sandboxes });
			});
		}
		try {
			store.reload();
		} catch {
			// Keep the state loaded at startup.
		}
		await ensureRunner(ctx, { ...store.get().sandboxes });
		pi.setActiveTools(pi.getActiveTools().length ? pi.getActiveTools() : pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
	});

	pi.on("session_shutdown", async () => {
		await (starting ?? Promise.resolve());
		await stopRunner();
		currentContext = undefined;
	});
}
