/** Shared types for the permissions extension. No runtime imports here. */

export type Risk = "read" | "write" | "execute";

export type ScopeMode = "project" | "everywhere";

/** One group of tool names. Builtin toolsets mirror the three risk flags. */
export interface Toolset {
	/** Stable identifier, unique across toolsets. */
	name: string;
	/** Risk class this toolset assigns to the tools it matches. */
	risk: Risk;
	/** JavaScript regular expression sources, tested against the tool name. */
	patterns: string[];
	/** A disabled custom toolset does not match anything. Builtin toolsets are always on. */
	enabled: boolean;
	/** True for the three toolsets that mirror the risk flags. */
	builtin: boolean;
}

export interface SandboxFlags {
	/** Reject bash commands that can change the filesystem. */
	readonly_bash: boolean;
	/** Reject bash commands that can reach the network. */
	no_network: boolean;
}

export interface PermissionsState {
	version: 1;
	flags: Record<Risk, boolean>;
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
export type BlockKind = "unknown" | "flag" | "scope";

export type GateDecision =
	| { block: false; patch?: GatePatch }
	| { block: true; reason: string; kind: BlockKind };

export interface Classification {
	risk: Risk;
	/** Names of the toolsets that matched. */
	toolsets: string[];
}
