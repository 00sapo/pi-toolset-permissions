import { isAbsolute, dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

const BUILTIN_EXTENSION_SOURCES = new Set(["builtin:codemode", "builtin:tool-search"]);

export function isBuiltinExtensionSource(path: unknown): path is string {
	return typeof path === "string" && BUILTIN_EXTENSION_SOURCES.has(path);
}

export function canonicalSource(path: string): string {
	if (isBuiltinExtensionSource(path)) return path;
	try { return realpathSync(path); } catch { return path; }
}

/** Mount a package, not only its entry point, so relative imports stay available. */
export function extensionRoot(path: string, exists = existsSync): string {
	const directory = dirname(path);
	for (let current = directory; ; current = dirname(current)) {
		if (exists(join(current, "package.json"))) return current;
		if (dirname(current) === current) return directory;
	}
}

export function extensionSources(tools: Array<any>, own: readonly string[], manual: string[], cwd: string): string[] {
	const paths = [...tools.filter(tool => !own.includes(tool.sourceInfo?.path))
		.map(tool => tool.sourceInfo?.path), ...manual.map(path => resolve(cwd, path))];
	return [...new Set(paths.filter(path => typeof path === "string" && (isAbsolute(path) || isBuiltinExtensionSource(path))).map(canonicalSource))].sort();
}

export function concise(error: unknown): string {
	return String(error instanceof Error ? error.message : error).split(/[\r\n]/)[0].replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240);
}

export function unavailable(name: string): string {
	return `Sandbox tool ${name} is unavailable. Reload Pi after fixing the extension, or explicitly add an exact-name pattern under Unsandboxed tools.`;
}

/**
 * True when the inner Pi registered this host tool from the same source and did not hide it.
 * A tool that the inner registered but did not declare on this turn still counts. An extension
 * can add and remove a tool between turns, as the pi-subagents loader does, and that is not an
 * incompatibility. A hidden inner tool is never callable, so it stays absent.
 */
export function hasInnerRegistration(name: string, entry: { sourceInfo?: { path?: string } } | undefined,
	inventory: ReadonlyMap<string, { path: string; exposure?: unknown }>, canonical = canonicalSource): boolean {
	const expected = entry?.sourceInfo?.path;
	const inner = inventory.get(name);
	return Boolean(expected && inner && inner.exposure !== "hidden" && canonical(expected) === canonical(inner.path));
}

// Pi 1.5.2 has no public executor interception API. Keep the adapter in one place.
// Each runtime finds its owner through a definition identity, never a global active session.
const KEY = Symbol.for("pi-toolset-permissions.registry-adapter.v1");
interface Owner { wrap: (tool: any) => any }
interface Adapter { owners: WeakMap<object, Owner>; original: Function }
export function attachRegistryAdapter(Runner: any, anchor: object, wrap: Owner["wrap"]): boolean {
	if (typeof Runner?.prototype?.getAllRegisteredTools !== "function") return false;
	const prototype = Runner.prototype;
	let adapter: Adapter = prototype[KEY];
	if (!adapter) {
		adapter = { owners: new WeakMap(), original: prototype.getAllRegisteredTools };
		Object.defineProperty(prototype, KEY, { value: adapter });
		prototype.getAllRegisteredTools = function () {
			const tools = adapter.original.call(this);
			if (!Array.isArray(tools)) throw new Error("Unsupported Pi tool registry.");
			const owner = tools.map(tool => adapter.owners.get(tool.definition)).find(Boolean);
			return owner ? tools.map(tool => owner.wrap(tool)) : tools;
		};
	}
	adapter.owners.set(anchor, { wrap });
	return true;
}
