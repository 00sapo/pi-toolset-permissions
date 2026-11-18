/** Shared types for the permissions extension. No runtime imports here. */

export type ScopeMode = "project" | "everywhere";

export type ToolsetMode = "off" | "on" | "ask";

export function toolsetMode(enabled: boolean | "ask"): ToolsetMode {
	return enabled === "ask" ? "ask" : enabled ? "on" : "off";
}

export function nextToolsetMode(enabled: boolean | "ask"): boolean | "ask" {
	return enabled === false ? true : enabled === true ? "ask" : false;
}

/** One group of tool names with a shared permission mode. */
export interface Toolset {
	/** Stable identifier, unique across toolsets. */
	name: string;
	/** JavaScript regular expression sources, tested against the tool name. */
	patterns: string[];
	/** False disables calls. True allows calls. Ask requires approval. */
	enabled: boolean | "ask";
	/** True for the toolsets that the extension ships. A builtin cannot be deleted. */
	builtin: boolean;
}

export interface SandboxFlags {
	/** Reject bash commands that can change the filesystem. */
	readonly_bash: boolean;
	/** Reject bash commands that can reach the network. */
	no_network: boolean;
}

export interface PermissionsState {
	version: 2;
	scope: ScopeMode;
	/** Absolute directories allowed in project scope. */
	extra_paths: string[];
	toolsets: Toolset[];
	sandboxes: SandboxFlags;
}

/** A path patch the gate asks pi to apply before the tool runs. */
export interface GatePatch {
	path: string;
}

/** Why the gate blocked a call. `unknown` means no toolset matched. */
export type BlockKind = "unknown" | "scope" | "disabled" | "ask";

export type GateDecision =
	| { block: false; patch?: GatePatch }
	| { block: true; reason: string; kind: BlockKind; toolsets?: string[] };

export interface Classification {
	/** Names of the toolsets that matched. */
	toolsets: string[];
	/** On takes priority when both on and ask toolsets match. */
	mode: "on" | "ask";
	/** Names of matching toolsets that require approval. */
	askToolsets: string[];
}
