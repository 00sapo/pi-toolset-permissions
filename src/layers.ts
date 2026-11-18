/** Sandbox layer decisions. Pure: no runtime imports, so the tests can load it. */

export interface SandboxLayers {
	readonly_bash: boolean;
	no_network: boolean;
}

/** At least one layer means that the execution process is needed. */
export function layersActive(layers: SandboxLayers): boolean {
	return layers.readonly_bash || layers.no_network;
}

/** A boundary is fixed when a process starts, so each combination needs a new process. */
export function layerKey(layers: SandboxLayers): string {
	return `${layers.readonly_bash ? "readonly" : "writable"}+${layers.no_network ? "offline" : "online"}`;
}

/** True when the loaded tool belongs to this extension and not to a third party. */
export function isOwnTool(ownPath: string, tool: { sourceInfo: { source?: string; path?: string } }): boolean {
	return tool.sourceInfo.source !== "builtin" && tool.sourceInfo.path === ownPath;
}

/** Tools from other extensions. They run in the host process, so they cannot be sandboxed. */
export function foreignTools(
	ownPath: string,
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
