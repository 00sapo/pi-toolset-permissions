import { evaluateCall } from "./gate.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalChoices, approvalLines, fullInputLines, plain, wrap } from "./approval-dialog.ts";
import type { StateStore } from "./state.ts";

interface ApprovalUI {
	hasUI: boolean;
	cwd: string;
	ui: {
		custom?: ExtensionContext["ui"]["custom"];
		select(title: string, choices: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
	};
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** One approval permits only the next call with the same tool and input. */
export class Approvals {
	#pending = new Map<string, number>();

	clear(): void { this.#pending.clear(); }

	consume(tool: string, input: Record<string, unknown>): boolean {
		const key = stable([tool, input]);
		const count = this.#pending.get(key) ?? 0;
		if (count === 0) return false;
		if (count === 1) this.#pending.delete(key);
		else this.#pending.set(key, count - 1);
		return true;
	}

	async request(store: StateStore, tool: string, input: Record<string, unknown>, reason: string, ctx: ApprovalUI): Promise<string> {
		if (!reason.trim()) return "Blocked: provide a reason for this call.";
		if (tool === "permissions" && input.action === "request_tool") return "Blocked: approval requests cannot request themselves.";
		const decision = evaluateCall(store.get(), tool, input, ctx.cwd);
		if (!decision.block) return "This call does not need approval. Call the tool directly.";
		if (decision.kind !== "ask") return decision.reason;
		if (!ctx.hasUI) return "Blocked: approval needs an interactive session.";
		const names = decision.toolsets;
		if (!names?.length) return "Blocked: no ask toolset was identified.";
		const choices = approvalChoices(names);
		const details = { tool, input, reason, names };
		const answer = ctx.ui.custom ? await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
			let selected = 0;
			let inspecting = false;
			let offset = 0;
			let full: string[] = [];
			let pageSize = 20;
			let visibleChoices = choices;
			const rows = () => Math.max(1, Math.floor(tui.terminal?.rows || 24));
			return {
				render(width: number): string[] {
					const columns = Math.max(1, width - 2);
					if (inspecting) {
						full = fullInputLines(details, columns, theme);
						const footer = wrap("j/k/arrows: scroll · PgUp/PgDn: page · h/esc: back", columns);
						pageSize = Math.max(1, rows() - footer.length - 1);
						offset = Math.max(0, Math.min(offset, full.length - pageSize));
						return [...full.slice(offset, offset + pageSize), "", ...footer].slice(0, rows());
					}
					const preview = approvalLines(details, columns, theme);
					visibleChoices = preview.includes("[...]") ? [...choices, "Inspect"] : choices;
					selected = Math.min(selected, visibleChoices.length - 1);
					return [...preview,
						...visibleChoices.flatMap((choice, index) => wrap(`${index === selected ? ">" : " "} ${plain(choice)}`, Math.max(1, width - 2))),
						"", ...wrap("j/k or arrows: select · l/enter: accept · h/esc: deny", Math.max(1, width - 2))];
				},
				handleInput(data: string): void {
					const up = data === "k" || data === "\x1b[A" || keys.matches(data, "tui.select.up");
					const down = data === "j" || data === "\x1b[B" || keys.matches(data, "tui.select.down");
					const back = data === "h" || data === "\x1b" || keys.matches(data, "tui.select.cancel");
					if (inspecting) {
						if (back) inspecting = false;
						else if (up) offset--;
						else if (down) offset++;
						else if (data === "\x1b[5~") offset -= pageSize;
						else if (data === "\x1b[6~") offset += pageSize;
						offset = Math.max(0, Math.min(offset, Math.max(0, full.length - pageSize)));
						tui.requestRender();
						return;
					}
					if (up) selected = (selected + visibleChoices.length - 1) % visibleChoices.length;
					else if (down) selected = (selected + 1) % visibleChoices.length;
					else if (back) { done(undefined); return; }
					else if (data === "l" || data === "\r" || keys.matches(data, "tui.select.confirm")) {
						if (visibleChoices[selected] === "Inspect") { inspecting = true; offset = 0; }
						else { done(visibleChoices[selected]); return; }
					}
					tui.requestRender();
				},
				invalidate(): void {},
			};
		}) : await ctx.ui.select(
			approvalLines(details, 78, { bold: (text) => text, fg: (_color, text) => text }).join("\n"), choices,
		);
		if (answer === "Deny with explanation") {
			const feedback = await ctx.ui.input("Why do you deny this call?", "Explain what the AI must change");
			return `Blocked: the user denied this call.${feedback?.trim() ? ` User explanation: ${feedback}` : ""}`;
		}
		if (answer !== "Allow once" && answer !== choices[3]) return "Blocked: the user denied this call.";
		// A dialog can stay open while another process changes the state.
		store.reload();
		const current = evaluateCall(store.get(), tool, input, ctx.cwd);
		if (current.block && current.kind !== "ask") return current.reason;
		if (answer === choices[3]) {
			store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
				names.includes(entry.name) && entry.enabled === "ask" ? { ...entry, enabled: true } : entry) }));
			return "Approved. The matching ask toolsets are now on.";
		}
		const key = stable([tool, input]);
		this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
		return "Approved once.";
	}
}
