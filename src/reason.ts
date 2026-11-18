interface MessageEntry {
	type: string;
	message?: { role: string; content: unknown };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n").trim();
}

/** Use public explanation only. Never show private reasoning or invent a purpose. */
export function callReason(branch: MessageEntry[], tool: string, input: Record<string, unknown>): string {
	let task = "";
	let explanation = "";
	let sawAssistant = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			task = textOf(entry.message.content);
			break;
		}
		if (entry.message.role === "assistant" && !sawAssistant) {
			sawAssistant = true;
			explanation = textOf(entry.message.content);
		}
	}
	if (explanation) return explanation;
	const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	const action = tool === "read" ? `Read ${path ?? "the requested file"}.`
		: tool === "edit" ? `Edit ${path ?? "the requested file"}.`
		: tool === "bash" ? "Run the shell command shown above."
		: `Use the tool ${tool}.`;
	const excerpt = task.length > 600 ? `${task.slice(0, 600)} [...]` : task;
	return `${action}\nThis agent did not provide a specific reason for this call.${excerpt ? `\nCurrent task: ${excerpt}` : ""}`;
}
