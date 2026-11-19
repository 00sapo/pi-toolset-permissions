import type { IncomingMessage, ServerResponse } from "node:http";

/** An authenticated, fixed-model endpoint. Credentials remain in the outer Pi. */
export async function handleModelRelay(req: IncomingMessage, res: ServerResponse, token: string,
	stream: ((context: any, signal: AbortSignal) => AsyncIterable<any>) | undefined,
	approve: ((event: any, signal: AbortSignal) => Promise<any>) | undefined): Promise<void> {
	if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
	if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
	const controller = new AbortController();
	res.on("close", () => controller.abort());
	try {
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Model request exceeds limit."); chunks.push(Buffer.from(chunk)); }
		const input = JSON.parse(Buffer.concat(chunks).toString());
		if (req.url === "/permissions") {
			if (!input || typeof input.toolName !== "string" || typeof input.toolCallId !== "string" || !input.input || typeof input.input !== "object") throw new Error("Invalid permission request.");
			if (!approve) throw new Error("The parent approval gate is unavailable.");
			res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await approve(input, controller.signal))); return;
		}
		if (!stream) throw new Error("The parent model is unavailable.");
		if (!input || !Array.isArray(input.messages)) throw new Error("Invalid model context.");
		res.setHeader("Content-Type", "application/x-ndjson");
		for await (const event of stream(input, controller.signal)) res.write(JSON.stringify(event) + "\n");
		res.end();
	} catch (error) {
		if (!res.headersSent) res.writeHead(400);
		res.end(JSON.stringify({ relayError: error instanceof Error ? error.message : String(error) }) + "\n");
	}
}
