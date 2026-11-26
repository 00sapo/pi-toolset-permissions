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
	let explanationWindow = true;
	let sawAssistant = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			task = textOf(entry.message.content);
			break;
		}
		if (entry.message.role === "toolResult") explanationWindow = false;
		if (entry.message.role === "assistant" && explanationWindow && !explanation) {
			const content = entry.message.content;
			// Earlier tool calls belong to another action, even if their result is absent.
			if (sawAssistant && Array.isArray(content) && content.some(part => part?.type === "toolCall")) {
				explanationWindow = false;
			} else {
				explanation = textOf(content);
			}
			sawAssistant = true;
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

/** Forward public text only, never the sandbox conversation or private thinking. */
export function permissionReason(ctx: { sessionManager: { getBranch(): MessageEntry[] } }, tool: string, input: Record<string, unknown>): string {
	try { return callReason(ctx.sessionManager.getBranch(), tool, input); }
	catch { return callReason([], tool, input); }
}

/** Missing relay metadata must never fall back to an unrelated host conversation. */
export function relayedReason(event: { approvalReason?: unknown; toolName: string; input: Record<string, unknown> }): string {
	return typeof event.approvalReason === "string" && event.approvalReason.trim()
		? event.approvalReason : callReason([], event.toolName, event.input);
}
