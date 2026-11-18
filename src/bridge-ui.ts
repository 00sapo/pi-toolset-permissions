export interface BridgeDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

/** The subset of ctx.ui that the isolated RPC bridge uses. */
export interface BridgeUI {
	select(title: string, options: string[], optionsUI?: BridgeDialogOptions): Promise<string | undefined>;
	confirm(title: string, message: string, options?: BridgeDialogOptions): Promise<boolean | undefined>;
	input(title: string, placeholder?: string, options?: BridgeDialogOptions): Promise<string | undefined>;
	editor(title: string, prefill?: string, options?: BridgeDialogOptions): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	setTitle(title: string): void;
	setEditorText(text: string): void;
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`Invalid UI request field: ${key}`);
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	return record[key] === undefined ? undefined : stringField(record, key);
}

function stringArray(value: unknown, key: string): string[] {
	if (!Array.isArray(value) || Array.from(value).some(item => typeof item !== "string")) {
		throw new Error(`Invalid UI request field: ${key}`);
	}
	return [...value];
}

/** UI failures reject so that the caller can fail the bridge operation. */
export async function forwardBridgeUI(
	request: unknown,
	ui: BridgeUI,
	signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid UI request");
	const record = request as Record<string, unknown>;
	if (record.type !== "extension_ui_request") throw new Error("Invalid UI request type");
	const id = stringField(record, "id");
	const method = stringField(record, "method");
	let show: (() => Promise<string | boolean | undefined>) | undefined;
	let effect: (() => void) | undefined;
	let options: BridgeDialogOptions | undefined;
	if (record.timeout !== undefined) {
		if (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout < 0) {
			throw new Error("Invalid UI request field: timeout");
		}
		options = { timeout: record.timeout };
	}
	if (signal) options = { ...options, signal };

	switch (method) {
		case "select": {
			const title = stringField(record, "title");
			const choices = stringArray(record.options, "options");
			show = () => ui.select(title, choices, options);
			break;
		}
		case "confirm": {
			const title = stringField(record, "title");
			const message = stringField(record, "message");
			show = () => ui.confirm(title, message, options);
			break;
		}
		case "input": {
			const title = stringField(record, "title");
			const placeholder = optionalString(record, "placeholder");
			show = () => ui.input(title, placeholder, options);
			break;
		}
		case "editor": {
			const title = stringField(record, "title");
			const prefill = optionalString(record, "prefill");
			show = () => ui.editor(title, prefill, options);
			break;
		}
		case "notify": {
			const message = stringField(record, "message");
			const type = record.notifyType === undefined ? "info" : record.notifyType;
			if (type !== "info" && type !== "warning" && type !== "error") throw new Error("Invalid UI request field: notifyType");
			effect = () => ui.notify(message, type);
			break;
		}
		case "setStatus": {
			const key = stringField(record, "statusKey");
			const text = optionalString(record, "statusText");
			effect = () => ui.setStatus(`isolated:${key}`, text);
			break;
		}
		case "setWidget": {
			const key = stringField(record, "widgetKey");
			const lines = record.widgetLines === undefined ? undefined : stringArray(record.widgetLines, "widgetLines");
			const placement = record.widgetPlacement === undefined ? "aboveEditor" : record.widgetPlacement;
			if (placement !== "aboveEditor" && placement !== "belowEditor") throw new Error("Invalid UI request field: widgetPlacement");
			effect = () => ui.setWidget(`isolated:${key}`, lines, { placement });
			break;
		}
		case "setTitle": {
			const title = stringField(record, "title");
			effect = () => ui.setTitle(title);
			break;
		}
		case "set_editor_text": {
			const text = stringField(record, "text");
			effect = () => ui.setEditorText(text);
			break;
		}
		default: throw new Error(`Unsupported UI method: ${method}`);
	}

	if (effect) {
		if (!signal?.aborted) effect();
		return undefined;
	}
	const cancelled = { type: "extension_ui_response", id, cancelled: true };
	if (signal?.aborted) return cancelled;

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const abort = () => { cleanup(); resolve(cancelled); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			Promise.resolve(show!()).then(value => {
				cleanup();
				if (signal?.aborted || value === undefined) { resolve(cancelled); return; }
				if (typeof value !== (method === "confirm" ? "boolean" : "string")) {
					reject(new Error("Invalid UI dialog result"));
					return;
				}
				resolve({ type: "extension_ui_response", id, [method === "confirm" ? "confirmed" : "value"]: value });
			}, error => { cleanup(); reject(error); });
		} catch (error) { cleanup(); reject(error); }
	});
}
