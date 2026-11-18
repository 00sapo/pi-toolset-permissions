import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

export default function bridgeFixture(pi: ExtensionAPI): void {
	let count = 0;
	pi.registerTool({
		name: `bridge_probe_${randomUUID().replaceAll("-", "")}`,
		label: "Bridge probe",
		description: "Exercise the live bridge with persistent state and a confirmation dialog.",
		parameters: Type.Object({ ask: Type.Boolean() }),
		outputSchema: Type.Object({ count: Type.Integer(), confirmed: Type.Boolean() }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			count += 1;
			const confirmed = params.ask
				? await ctx.ui.confirm("Bridge probe", "Allow the live probe?")
				: false;
			return {
				content: [
					{ type: "text", text: `Probe ${count}` },
					{
						type: "image", mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
					},
				],
				structuredContent: { count, confirmed },
				details: { count, confirmed, nested: { values: ["fixture", null, 7] } },
			};
		},
	});
}
