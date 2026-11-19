/**
 * Reports to the terminal host that the extension waits for the user.
 *
 * Herdr reads one event on the Pi bus: `herdr:blocked` with `{ active: true, label }`
 * marks the pane as blocked and notifies the user, and `{ active: false }` clears it.
 * Outside Herdr no listener reads the event, so the call does nothing there.
 *
 * Pi publishes `ui_prompt_start` and `ui_prompt_end` around every dialog that an
 * extension shows, and it opens one span for a group of nested dialogs. Following
 * those events covers the approval dialog, the unknown-tool question, the change
 * confirmations, and a dialog that a subagent or the isolated executor raises in this
 * window.
 *
 * A prompt that the user starts is not a question for the user. The `/permissions`
 * screen runs inside `suppressPrompts`, so browsing the screen never reports a block.
 */

/** The part of `pi.events` that this module uses. */
export interface EventBus {
	emit?(name: string, data: unknown): void;
}

/** The part of `pi` that this module uses. */
export interface PromptSource {
	events?: EventBus;
	on(name: string, handler: (event: unknown, ctx: unknown) => void): () => void;
}

export interface PromptEvent {
	kind?: string;
	title?: string;
}

const EVENT = "herdr:blocked";

/** The extension API objects that already report prompt events. */
const installed = new WeakSet<object>();

/** How many user-started prompts are open now. */
let suppressed = 0;

/** The text that the host shows for a waiting question. */
export function promptLabel(event: PromptEvent): string {
	const title = typeof event.title === "string" ? event.title.trim() : "";
	if (title) return title;
	switch (event.kind) {
		case "select":
			return "Choose an answer";
		case "confirm":
			return "Confirm an action";
		case "input":
			return "Type an answer";
		case "editor":
			return "Write an answer";
		default:
			return "Waiting for your answer";
	}
}

/** Runs a screen that the user opens, without reporting it as a waiting question. */
export async function suppressPrompts<T>(run: () => Promise<T>): Promise<T> {
	suppressed += 1;
	try {
		return await run();
	} finally {
		suppressed -= 1;
	}
}

/**
 * Reports the open question of a session. A second call on the same API does nothing,
 * because each call installs handlers for the same events.
 */
export function reportPrompts(pi: PromptSource): void {
	if (installed.has(pi)) return;
	installed.add(pi);

	let open = false;
	let skipped = false;
	const emit = (data: { active: boolean; label?: string }): void => {
		try {
			pi.events?.emit?.(EVENT, data);
		} catch {
			// A host without a bus, or a listener that throws, must not stop a dialog.
		}
	};

	pi.on("ui_prompt_start", (raw) => {
		// The start event arrives on a microtask, so a screen that suppresses its own
		// span is still counting it when this handler runs.
		if (suppressed > 0) {
			skipped = true;
			return;
		}
		skipped = false;
		open = true;
		emit({ active: true, label: promptLabel((raw ?? {}) as PromptEvent) });
	});

	pi.on("ui_prompt_end", () => {
		if (skipped) {
			skipped = false;
			return;
		}
		if (!open) return;
		open = false;
		emit({ active: false });
	});

	// A shutdown with a dialog still open must not leave the pane blocked.
	pi.on("session_shutdown", () => {
		skipped = false;
		if (!open) return;
		open = false;
		emit({ active: false });
	});
}
