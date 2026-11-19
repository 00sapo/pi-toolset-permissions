import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Report provenance without executing any tool. The outer runner consumes this notification. */
export default function inventory(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => {
		ctx.ui.notify(JSON.stringify({
			piToolsetInventory: 1,
			tools: pi.getAllTools().map(tool => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
		}), "info");
	});
}
