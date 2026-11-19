import { scopeRoots } from "./scope.ts";
import type { ExtensionAPI, ExtensionContext, Tool } from "@earendil-works/pi-coding-agent";
import { createCodingTools, getAgentDir, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { realpathSync, statSync } from "node:fs";
import { IsolatedRunner } from "./isolated-runner.ts";
import { forwardBridgeUI } from "./bridge-ui.ts";
import { StateStore } from "./state.ts";
import { reportPrompts, suppressPrompts } from "./notify.ts";
import { openPermissions } from "./ui.ts";
import { statusLine } from "./status.ts";
import { isExempt, layerKey, layersActive, ownPaths } from "./layers.ts";
import { attachRegistryAdapter, concise, extensionSources, unavailable, canonicalSource } from "./forwarding.ts";
import { registerPermissionsTool } from "./tool.ts";
import { Approvals } from "./approval.ts";
import type { SandboxLayers } from "./layers.ts";

/**
 * Isolated entry point. Every built-in tool name becomes a delegate. With no layer the delegate
 * calls the host implementation. With a layer on it calls an isolated Pi unless explicitly
 * exempted. Extension initialization and hooks remain on the host.
 *
 * `registerPermissionsCommand` is false when the caller already registers `/permissions`.
 */
export default function isolatedExtension(pi: ExtensionAPI): void {
	install(pi, { registerPermissionsCommand: true });
}

export interface IsolatedOptions {
	/** True when this module also owns the `/permissions` command. */
	registerPermissionsCommand: boolean;
}

/** The executor, without the entry-point decision. The default extension calls it on Linux. */
export function install(pi: ExtensionAPI, options: IsolatedOptions): void {
	if (process.env.PI_TOOLSET_INNER === "1") throw new Error("The isolated entry point cannot load inside its own child.");
	const store = new StateStore();
	// Every file of this extension. A tool registered by index.ts or isolated.ts is our own code.
	const ownPath = ownPaths(fileURLToPath(import.meta.url));
	/** A question from this process or from the inner Pi reaches the host as a prompt. */
	reportPrompts(pi);

	let runner: IsolatedRunner | undefined;
	let runnerKey: string | undefined;
	let starting: Promise<void> | undefined;
	let currentContext: ExtensionContext | undefined;
	let currentSignal: AbortSignal | undefined;
	let shadows: Map<string, Tool> | undefined;
	let wired = false;
	let registered = false;
	let available = new Set<string>();
	let serial: Promise<unknown> = Promise.resolve();
	const delegated = new Set<string>();
	const originals = new Map<string, any>();
	const wrappers = new WeakMap<object, any>();
	const anchor = {
		name: "__permissions_executor_anchor", label: "Executor anchor", description: "Private executor anchor",
		parameters: { type: "object", properties: {} }, exposure: "hidden" as const,
		execute: async () => { throw new Error("Private executor anchor."); },
	};
	const adapterReady = attachRegistryAdapter(ExtensionRunner, anchor, (entry) => {
		const tool = entry.definition;
		if (ownPath.includes(entry.sourceInfo?.path) || tool === anchor) return entry;
		let wrapped = wrappers.get(tool);
		if (!wrapped) {
			originals.set(tool.name, entry);
			delegated.add(tool.name);
			wrapped = { ...entry, definition: { ...tool, executionMode: "sequential",
				execute: (id: any, params: any, signal: any, update: any, ctx: any) => dispatch(tool, id, params, signal, update, ctx),
			} };
			wrappers.set(tool, wrapped);
		}
		return wrapped;
	});
	pi.registerTool(anchor as any);
	registerPermissionsTool(pi, store, () => status(undefined), new Approvals());

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

	/** The footer names the layers, their depth, and their platform limit. */
	function status(text: string | undefined): void {
		try {
			const context = currentContext;
			if (!context) return;
			context.ui.setStatus("isolated", text ?? statusLine(store.get(), "all-tools"));
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

	/**
	 * The roots that the layer may reach. A missing path is skipped instead of thrown, because
	 * a removable disk can disappear and that must not stop Pi or block every call.
	 */
	function allowedRoots(ctx: ExtensionContext): string[] {
		const found: string[] = [];
		for (const path of scopeRoots(store.get(), ctx.cwd)) {
			try {
				found.push(realpathSync(path));
			} catch {
				// A path that no longer exists cannot be a root.
			}
		}
		return [...new Set(found)];
	}

	function configurationKey(ctx: ExtensionContext, layers: SandboxLayers): string {
		return JSON.stringify([layerKey(layers, layers.filesystem === "off" ? [] : allowedRoots(ctx)), sources(ctx)]);
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
		const key = configurationKey(ctx, layers);
		if (runner && runnerKey === key) return runner;
		if (starting) {
			await starting;
			return runnerKey === key ? runner : ensureRunner(ctx, layers);
		}
		status("isolated:starting");
		starting = (async () => {
			try {
				await stopRunner();
				let paths = sources(ctx);
				let started: Awaited<ReturnType<typeof IsolatedRunner.start>>;
				for (;;) {
					try {
						started = await IsolatedRunner.start({
							cwd: ctx.cwd,
							extensions: paths,
							filesystem: layers.filesystem,
							paths: allowedRoots(ctx),
							network: layers.no_network,
							piPath: pi.getFlag("inner-pi") as string | undefined,
							nodePath: pi.getFlag("inner-node") as string | undefined,
							piAgentDir: agentDirectory(),
							onUI: async (request) => {
								if (!currentContext) throw new Error("The outer UI is unavailable.");
								return forwardBridgeUI(request, currentContext.ui, currentSignal);
							},
						});
						break;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const failed = paths.find(path => message.includes(`Failed to load extension "${path}":`));
						if (!failed) throw error;
						paths = paths.filter(path => path !== failed);
						ctx.ui.notify(`Sandbox extension unavailable: ${failed}. Fix its load error and reload Pi, or explicitly exempt its tools under Unsandboxed tools.`, "warning");
					}
				}
				// The layers can change while the process starts.
				if (configurationKey(ctx, store.get().sandboxes) !== key) {
					await started.runner.close();
					return;
				}
				available = new Set(started.tools.map(tool => tool.function.name));
				for (const [name, entry] of originals) {
					const expected = entry.sourceInfo?.path;
					const actual = started.runner.inventory.get(name);
					if (!expected || !actual || canonicalSource(expected) !== canonicalSource(actual)) available.delete(name);
				}
				for (const name of originals.keys()) {
					if (!available.has(name) && !store.get().unsandboxed_tools.some(pattern => isExempt(pattern, name))) {
						ctx.ui.notify(unavailable(name), "warning");
					}
				}
				for (const declaration of started.tools) {
					const tool = declaration.function;
					if (pi.getAllTools().some(entry => entry.name === tool.name)) continue;
					delegated.add(tool.name);
					pi.registerTool({ name: tool.name, label: tool.name, description: tool.description ?? tool.name,
						parameters: tool.parameters, executionMode: "sequential",
						execute: (_id, args, signal, update, context) => dispatch({ name: tool.name,
							execute: async () => { throw new Error(`Tool ${tool.name} has no host implementation.`); },
						} as any, _id, args, signal, update, context),
					} as any);
				}
				runner = started.runner;
				runnerKey = key;
				status(`isolated:ready ${started.tools.length} tools`);
			} catch (error) {
				await stopRunner();
				status("isolated:unavailable");
				ctx.ui.notify(`The isolated executor is unavailable: ${concise(error)}`, "error");
			} finally {
				starting = undefined;
			}
		})();
		await starting;
		return runnerKey === key ? runner : undefined;
	}

	/**
	 * The host Pi configuration directory. The sandbox mounts its rules, agents, extensions,
	 * skills, prompts, themes, and packages read-only. A path that does not exist mounts nothing.
	 */
	function agentDirectory(): string | undefined {
		try {
			const path = realpathSync(getAgentDir());
			return statSync(path).isDirectory() ? path : undefined;
		} catch {
			return undefined;
		}
	}

	/** A layer is on, so a missing executor is an error and never a fallback to the host. */
	async function runIsolated(ctx: ExtensionContext, name: string, args: unknown, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined) {
		let active: IsolatedRunner | undefined;
		try { active = await ensureRunner(ctx, { ...store.get().sandboxes }); }
		catch (error) { throw new Error(`Sandbox startup failed: ${concise(error)}`); }
		if (!active) throw new Error("The isolated executor is unavailable. Fix the reported startup error and retry.");
		if (!available.has(name)) throw new Error(unavailable(name));
		try {
			const response = await active.execute(name, args, signal, onUpdate);
			return { ...(response.result as any), isError: response.isError };
		} catch (error) {
			await stopRunner();
			throw new Error(`Sandbox call failed: ${concise(error)}`);
		}
	}

	async function dispatch(tool: Tool, id: any, params: any, signal: any, onUpdate: any, ctx: any) {
		currentContext = ctx;
		try {
			store.reload();
		} catch {
			// An unreadable file keeps the last good state.
		}
		const layers = { ...store.get().sandboxes };
		// The exception list is the user's decision, so a matching tool keeps the host implementation.
		const exempt = store.get().unsandboxed_tools.some((pattern) => isExempt(pattern, tool.name));
		if (!layersActive(layers) || exempt) return (tool.execute as any)(id, params, signal, onUpdate, ctx);
		const pending = serial.catch(() => {}).then(async () => {
			if (signal?.aborted) throw new Error("Sandbox call cancelled.");
			currentContext = ctx;
			currentSignal = signal;
			try { return await runIsolated(ctx, tool.name, params, signal, onUpdate); }
			finally { currentSignal = undefined; }
		});
		serial = pending;
		return pending;
	}

	// The layer screen. A change calls the store listener above, which restarts the process.
	if (options.registerPermissionsCommand) {
		pi.registerCommand("permissions", {
			description: "Tool permissions, scope, and sandbox layers",
			handler: async (_args, ctx) => {
				currentContext = ctx;
				try {
					store.reload();
				} catch {
					// Keep the state loaded at startup.
				}
				try {
					// The user opened this screen, so it is not a question for the user.
					await suppressPrompts(
						() => openPermissions(store, ctx, pi.getAllTools().map((tool) => tool.name), "all-tools"),
					);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`The permissions screen failed: ${messageOf(error)}`, "error");
				}
			},
		});
	}

	function messageOf(error: unknown): string { return concise(error); }

	function sources(ctx: ExtensionContext): string[] {
		return extensionSources([...originals.values(), ...pi.getAllTools()], ownPath, extensionPaths(), ctx.cwd);
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
		if (layersActive(layers) && !store.get().unsandboxed_tools.some(pattern => isExempt(pattern, event.toolName))) {
			const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
			if (tool && !ownPath.includes(tool.sourceInfo.path) && (tool.sourceInfo.source === "sdk" || !adapterReady || !delegated.has(event.toolName))) {
				return { block: true, reason: unavailable(event.toolName) };
			}
		}
		return undefined;
	});

	function register(cwd: string): void {
		if (registered) return;
		registered = true;
		for (const tool of hostTools(cwd)) {
			if (pi.getAllTools().find(entry => entry.name === tool.name)?.sourceInfo.source !== "builtin") continue;
			delegated.add(tool.name);
			pi.registerTool({
				...tool,
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				executionMode: "sequential",
				execute: (id, params, signal, onUpdate, ctx) => dispatch(tool, id, params, signal, onUpdate, ctx),
			});
		}
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		try { await ensureRunner(ctx, { ...store.get().sandboxes }); }
		catch (error) {
			status("isolated:unavailable");
			ctx.ui.notify(`The isolated executor is unavailable: ${concise(error)}`, "error");
		}
	}

	pi.on("session_start", async (event, ctx) => {
		currentContext = ctx;
		if (event.reason !== "reload") registered = false;
		register(ctx.cwd);
		if (!wired) {
			wired = true;
			store.onChange(() => {
				if (currentContext) void refresh(currentContext);
			});
		}
		try {
			store.reload();
		} catch {
			// Keep the state loaded at startup.
		}
		await refresh(ctx);
		pi.setActiveTools(pi.getActiveTools().length ? pi.getActiveTools() : pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
	});

	pi.on("session_shutdown", async () => {
		await (starting ?? Promise.resolve());
		await stopRunner();
		currentContext = undefined;
	});
}
