/** Sandbox layer decisions. Pure: no runtime imports, so the tests can load it. */

import type { SandboxFlags } from "./types.ts";

export type SandboxLayers = SandboxFlags;

/** At least one layer means that the execution process is needed. */
export function layersActive(layers: SandboxLayers): boolean {
	return layers.filesystem !== "off" || layers.no_network;
}

/** A boundary is fixed when a process starts, so each combination needs a new process. */
export function layerKey(layers: SandboxLayers, paths: readonly string[] = []): string {
	return JSON.stringify([layers.filesystem, layers.no_network, [...new Set(paths)].sort()]);
}

/** True when the loaded tool belongs to this extension and not to a third party. */
export function isOwnTool(ownPath: string | readonly string[], tool: { sourceInfo: { source?: string; path?: string } }): boolean {
	if (tool.sourceInfo.source === "builtin") return false;
	const paths = typeof ownPath === "string" ? [ownPath] : ownPath;
	return tool.sourceInfo.path !== undefined && paths.includes(tool.sourceInfo.path);
}

/**
 * Every file that belongs to this extension. A tool registered by any of them is not
 * third-party code, so it may become a delegate.
 */
export function ownPaths(modulePath: string): string[] {
	const index = modulePath.replace(/isolated\.ts$/, "index.ts");
	return index === modulePath ? [modulePath] : [modulePath, index];
}

/** Tools from other extensions. They run in the host process, so they cannot be sandboxed. */
export function foreignTools(
	ownPath: string | readonly string[],
	tools: Array<{ name: string; sourceInfo: { source?: string; path?: string } }>,
): string[] {
	return tools
		.filter((tool) => tool.sourceInfo.source !== "builtin" && !isOwnTool(ownPath, tool))
		.map((tool) => tool.sourceInfo.path ?? tool.name);
}

/**
 * Decides which tools may answer a call. With no layer, the host answers. With a layer on,
 * only a delegate of the running executor answers.
 */
export function decideCall(
	layers: SandboxLayers,
	delegated: ReadonlySet<string>,
	toolName: string,
): { block: true; reason: string } | undefined {
	if (!layersActive(layers)) return undefined;
	if (delegated.has(toolName)) return undefined;
	return {
		block: true,
		reason: "A sandbox layer is on, so the call may run only through the isolated executor.",
	};
}
