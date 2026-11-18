/** What a sandbox covers on each platform, and which entry point applies. Pure: no runtime imports. */
import type { SandboxTarget } from "./sandbox-scope.ts";

export type PlatformPlan = "isolated" | "bash-only" | "disabled";

export interface PlatformPolicy {
	plan: PlatformPlan;
	/** The entry point that the platform needs. */
	entryPoint: SandboxTarget;
	/** What the screen and the footer say about coverage. */
	coverage: string;
	/** Why the platform is limited, or how to fix it. Absent on Linux. */
	reason?: string;
}

/**
 * Linux runs the isolated executor, so every tool stays inside the sandbox.
 * macOS runs the default extension, which wraps bash only, so other tools must be off.
 * Windows has no backend, so the layers are disabled and the screen says how to move on.
 */
export function platformPolicy(platform: NodeJS.Platform = process.platform): PlatformPolicy {
	if (platform === "linux") {
		return {
			plan: "isolated",
			entryPoint: "all-tools",
			coverage: "Every tool runs inside the sandbox.",
		};
	}
	if (platform === "darwin") {
		return {
			plan: "bash-only",
			entryPoint: "bash",
			coverage: "The sandbox covers bash only. Turn every other toolset off.",
			reason: "macOS has no isolated executor. The other tools run on the host.",
		};
	}
	if (platform === "win32") {
		return {
			plan: "disabled",
			entryPoint: "bash",
			coverage: "The sandbox is disabled on Windows.",
			reason: "Native Windows has no backend. Start Pi inside WSL2 to use the sandbox.",
		};
	}
	return {
		plan: "disabled",
		entryPoint: "bash",
		coverage: "The sandbox is disabled on this system.",
		reason: `No sandbox backend exists for ${platform}. Start Pi inside WSL2 or on Linux.`,
	};
}

/** False when the layers cannot run at all. The screen then shows the reason and no switch. */
export function layersEnabled(policy: PlatformPolicy): boolean {
	return policy.plan !== "disabled";
}

/** True when a layer covers only bash, so every other tool must be off. */
export function requiresBashOnly(policy: PlatformPolicy): boolean {
	return policy.plan === "bash-only";
}
