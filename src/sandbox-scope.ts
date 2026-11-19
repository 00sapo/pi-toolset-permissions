/** What a sandbox covers, and where it works. Pure: no runtime imports, so the tests can load it. */

export type SandboxTarget = "all-tools" | "bash";

export interface SandboxAvailability {
	/** `all-tools` for the isolated executor, `bash` for the default extension. */
	target: SandboxTarget;
	platform: NodeJS.Platform;
	/** False when a layer cannot start on this system. A layer then blocks every call. */
	available: boolean;
	/** One line for the screen. It names the coverage and the platform. */
	summary: string;
	/** Why the layer cannot run here. Present only when `available` is false. */
	reason?: string;
	/** A caveat about a layer that does run. Present only when `available` is true. */
	note?: string;
}

const COVERAGE: Record<SandboxTarget, string> = {
	"all-tools": "Applies to every tool.",
	bash: "Applies to bash only.",
};

/**
 * The sandbox backends differ per platform. The isolated executor needs bubblewrap, so it
 * runs on Linux only. The default extension wraps one shell tool, so macOS also works.
 */
export function sandboxAvailability(target: SandboxTarget, platform: NodeJS.Platform = process.platform): SandboxAvailability {
	const coverage = COVERAGE[target];
	if (target === "all-tools") {
		if (platform === "linux") {
			return { target, platform, available: true, summary: `${coverage} Linux only, through bubblewrap.` };
		}
		if (platform === "darwin") {
			return {
				target, platform, available: false,
				summary: `${coverage} Linux only, through bubblewrap.`,
				reason: "The isolated executor does not run on macOS. Turn every layer off, or start Pi inside a Linux host.",
			};
		}
		if (platform === "win32") {
			return {
				target, platform, available: false,
				summary: `${coverage} Linux only, through bubblewrap.`,
				reason: "The isolated executor does not run on Windows. Turn every layer off, or start Pi inside WSL2.",
			};
		}
		return {
			target, platform, available: false,
			summary: `${coverage} Linux only, through bubblewrap.`,
			reason: `The isolated executor is not available on ${platform}. Turn every layer off.`,
		};
	}

	if (platform === "linux") {
		return { target, platform, available: true, summary: `${coverage} Linux and macOS, through bubblewrap or Seatbelt.` };
	}
	if (platform === "darwin") {
		return {
			target, platform, available: true,
			summary: `${coverage} Linux and macOS, through bubblewrap or Seatbelt.`,
			note: "macOS needs sandbox-exec. Apple deprecated it, but current versions still provide it.",
		};
	}
	if (platform === "win32") {
		return {
			target, platform, available: false,
			summary: `${coverage} Linux and macOS only.`,
			reason: "Native Windows has no backend, so every shell call fails while a layer is on. Start Pi inside WSL2, or turn the layers off.",
		};
	}
	return {
		target, platform, available: false,
		summary: `${coverage} Linux and macOS only.`,
		reason: `No sandbox backend exists for ${platform}. Turn the layers off.`,
	};
}

/** True when a layer can start here. A missing backend must never run a call unsandboxed. */
export function canUseSandbox(target: SandboxTarget, platform: NodeJS.Platform = process.platform): boolean {
	return sandboxAvailability(target, platform).available;
}

/** One line for the Sandboxes section of the screen. It names the tool coverage. */
const MENU_NOTE: Record<SandboxTarget, string> = {
	"all-tools": "Applies to all tools except unsandboxed tools.",
	bash: "Applies to only bash.",
};

/**
 * The lines under the Sandboxes heading. They sit above the layer rows. An available layer
 * shows what it covers, plus any caveat. An unavailable layer shows why, and what to do instead.
 */
export function sandboxMenuNote(target: SandboxTarget, platform: NodeJS.Platform = process.platform): string[] {
	const where = sandboxAvailability(target, platform);
	const lines = [where.available ? MENU_NOTE[target] : (where.reason ?? MENU_NOTE[target])];
	if (where.note !== undefined) lines.push(where.note);
	return lines;
}

/** Coverage stays visible in the section title, even when no layer is active. */
export function sandboxSectionTitle(platform: NodeJS.Platform = process.platform): string {
	if (platform === "linux") return "Sandboxes (ALL tools · Linux)";
	if (platform === "darwin") return "Sandboxes (bash ONLY · macOS)";
	return "Sandboxes (DISABLED · use WSL2)";
}

/** The mark next to a layer row. It is empty when the layer can run on this system. */
export function sandboxRowMark(target: SandboxTarget, platform: NodeJS.Platform = process.platform): string {
	return sandboxAvailability(target, platform).available ? "" : " [unavailable here]";
}
