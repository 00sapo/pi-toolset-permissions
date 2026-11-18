/**
 * State that a session and its children share inside one process.
 *
 * A child session runs in the same process but gets its own resource loader, so
 * each session has a separate copy of this module and a separate event bus. A
 * registry on `globalThis` is the only channel the copies share.
 */

/** How a child session reaches the session that started it. */
export interface ChildLink {
	parentSessionId: string;
}

/** One ask decision that waits for a human. */
export interface ForwardedAsk {
	sessionId: string;
	agent?: string;
	tool: string;
	input: Record<string, unknown>;
	reason: string;
	names: string[];
}

/** What the parent dialog returned. */
export interface ForwardReply {
	choice: string;
	explanation?: string;
}

export type Forwarder = (ask: ForwardedAsk) => Promise<ForwardReply | undefined>;

export type ForwardOutcome =
	| { kind: "reply"; reply: ForwardReply }
	| { kind: "unavailable"; reason: string };

interface Registry {
	/** Which instance owns each live session. */
	owners: Map<string, object>;
	/** Child session to its parent session. */
	children: Map<string, ChildLink>;
	/** Session id to the dialog runner of that session. */
	forwarders: Map<string, Forwarder>;
}

const KEY = Symbol.for("pi-toolset-permissions.registry");
const TIMEOUT_ENV = "PI_PERMISSIONS_ASK_TIMEOUT_MS";
const DEFAULT_TIMEOUT = 120_000;

function store(): Registry {
	const slot = globalThis as unknown as Record<symbol, Registry | undefined>;
	let current = slot[KEY];
	if (current === undefined) {
		current = { owners: new Map(), children: new Map(), forwarders: new Map() };
		slot[KEY] = current;
	}
	return current;
}

/**
 * Claims a session for one instance. A second copy of the extension that loads
 * into the same session loses the claim and stays passive.
 */
export function claimSession(sessionId: string, token: object): boolean {
	const owners = store().owners;
	const holder = owners.get(sessionId);
	if (holder !== undefined && holder !== token) return false;
	owners.set(sessionId, token);
	return true;
}

export function releaseSession(sessionId: string, token: object): void {
	const owners = store().owners;
	if (owners.get(sessionId) === token) owners.delete(sessionId);
	store().forwarders.delete(sessionId);
}

export function setChild(sessionId: string, link: ChildLink): void {
	store().children.set(sessionId, link);
}

export function childLink(sessionId: string): ChildLink | undefined {
	return store().children.get(sessionId);
}

export function dropChild(sessionId: string): void {
	const state = store();
	state.children.delete(sessionId);
	state.forwarders.delete(sessionId);
}

export function setForwarder(sessionId: string, forwarder: Forwarder): void {
	store().forwarders.set(sessionId, forwarder);
}

export function dropForwarder(sessionId: string): void {
	store().forwarders.delete(sessionId);
}

/** The session id of the process-wide child marker, when this process is a child. */
export function environmentParent(): string | undefined {
	const value = process.env.PI_SUBAGENT_PARENT_SESSION;
	return value !== undefined && value !== "" ? value : undefined;
}

function timeoutOf(): number {
	const raw = Number(process.env[TIMEOUT_ENV]);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT;
}

/** Waits for the parent session to answer one ask. */
export async function askParent(ask: ForwardedAsk): Promise<ForwardOutcome> {
	const link = childLink(ask.sessionId);
	const parentSessionId = link?.parentSessionId ?? environmentParent();
	if (parentSessionId === undefined) {
		return {
			kind: "unavailable",
			reason: "Blocked: this call needs approval, and this session has no parent interface to ask. Run the call in the main session, or turn on the matching toolset.",
		};
	}
	const forwarder = store().forwarders.get(parentSessionId);
	if (forwarder === undefined) {
		return {
			kind: "unavailable",
			reason: link === undefined
				? "Blocked: this call needs approval, and the parent session runs in another process, which cannot show the dialog. Run the call in the main session, or turn on the matching toolset."
				: "Blocked: this call needs approval, and the parent session is not answering approval requests. Turn on the matching toolset, or run the call in the main session.",
		};
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ForwardOutcome>((resolve) => {
		timer = setTimeout(() => resolve({
			kind: "unavailable",
			reason: "Blocked: the parent session did not answer this approval request in time. Nothing was changed.",
		}), timeoutOf());
	});
	try {
		// The forwarder resolves a reply and the timer resolves an outcome, so wrap
		// the reply in the same shape before the race.
		const answered = forwarder(ask).then<ForwardOutcome>((reply) => reply === undefined
			? { kind: "unavailable", reason: "Blocked: the parent session closed the approval request. Nothing was changed." }
			: { kind: "reply", reply });
		return await Promise.race([answered, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
