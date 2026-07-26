/**
 * JSON-RPC framing and the caller-identity handshake.
 *
 * Hand-rolled, newline-delimited, zero dependencies — matching this template's
 * no-dependency script convention. The protocol surface used here is small
 * enough that a dependency would be more risk than the code it replaces.
 *
 * THE PART THAT IS NOT BOILERPLATE
 *
 * A server can ask the CLIENT which directories the calling session is working
 * in (`roots/list`). That is what turns "any repo can read the vault" into "this
 * repo sees what belongs to it", and it is derived from the client rather than
 * declared by the caller, which is what makes it a boundary at all.
 *
 * But it is ASYNCHRONOUS, and `resources/list` arrives before it resolves — in
 * practice, not in theory. Announcing `notifications/resources/list_changed`
 * afterwards was tried first and the client did not re-fetch, so the listing
 * stayed unscoped. The deterministic fix is to make scope-dependent requests
 * WAIT for identity, capped so a client that never answers cannot hang the
 * server: **something that scopes by caller must not answer before it knows the
 * caller.**
 */

import { sanitize, callerProject, type Root } from "./mcp-caller.ts";

/** How long a scope-dependent request waits for identity before proceeding. */
export const IDENTITY_TIMEOUT_MS = 2_000;

/** Server-initiated request ids start high, so they cannot collide with the client's. */
const SERVER_ID_BASE = 10_000;

export type Send = (msg: unknown) => void;
export type Handler = (id: number | string, params: unknown) => unknown | Promise<unknown>;
export type Handlers = Record<string, Handler>;

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

export interface SessionOptions {
	readonly send: Send;
	readonly handlers: Handlers;
	/** Called when identity is established or changes. */
	readonly onIdentified?: (roots: readonly Root[]) => void;
	readonly identityTimeoutMs?: number;
}

/**
 * One MCP session over one stdio pair.
 *
 * A class rather than module state so a test can drive several independently —
 * the prototype's module-level `callerRoots` made the identity race untestable,
 * which is precisely why it took a live client to find.
 */
export class McpSession {
	readonly #send: Send;
	readonly #handlers: Handlers;
	readonly #onIdentified: ((roots: readonly Root[]) => void) | undefined;
	readonly #identityTimeoutMs: number;

	#roots: Root[] = [];
	#rootsRequestId: number | null = null;
	#nextServerId = SERVER_ID_BASE;
	#identified = false;
	#refresh: Promise<void> | null = null;
	#resolveRefresh: (() => void) | null = null;
	#resolveIdentity!: () => void;
	readonly #identityKnown: Promise<void>;

	constructor({ send, handlers, onIdentified, identityTimeoutMs = IDENTITY_TIMEOUT_MS }: SessionOptions) {
		this.#send = send;
		this.#handlers = handlers;
		this.#onIdentified = onIdentified;
		this.#identityTimeoutMs = identityTimeoutMs;
		this.#identityKnown = new Promise<void>((res) => {
			this.#resolveIdentity = res;
		});
	}

	get roots(): readonly Root[] {
		return this.#roots;
	}

	get identified(): boolean {
		return this.#identified;
	}

	get project(): string | null {
		return callerProject(this.#roots);
	}

	/**
	 * Await identity, or give up after the cap.
	 *
	 * Resolving on timeout rather than rejecting is deliberate: a client that
	 * never answers `roots/list` gets an anonymous, general-only view, which is
	 * the safe degradation. Hanging would be worse than being unhelpful.
	 */
	identityReady(): Promise<void> {
		// A refresh in flight is awaited even though identity is already known:
		// answering now would answer for whoever the caller USED to be.
		if (this.#refresh) return this.#bounded(this.#refresh);
		if (this.#identified) return Promise.resolve();
		return this.#bounded(this.#identityKnown);
	}

	/** Await `p`, or give up after the cap. Resolves either way. */
	#bounded(p: Promise<void>): Promise<void> {
		return new Promise<void>((res) => {
			// The timer is deliberately NOT unref'd: it is the only thing keeping
			// this wait alive, and an unref'd one lets the loop drain with the
			// promise still pending — the wait never resolves at all. It is cleared
			// the moment identity arrives, so the normal path costs nothing.
			const timer = setTimeout(res, this.#identityTimeoutMs);
			const settle = (): void => {
				clearTimeout(timer);
				res();
			};
			p.then(settle, settle);
		});
	}

	/**
	 * Ask the client who it is.
	 *
	 * A REFRESH (triggered by `notifications/roots/list_changed`) opens a pending
	 * gate. Without it, `identityReady()` returned immediately because identity
	 * was already established, so a tool call arriving between the notification
	 * and the reply was served under the STALE identity — the wrong project, and
	 * therefore the wrong scope. Same class as the original first-listing race,
	 * one step later in the lifecycle.
	 */
	requestRoots(): void {
		this.#rootsRequestId = ++this.#nextServerId;
		if (this.#identified && !this.#refresh) {
			this.#refresh = new Promise<void>((res) => {
				this.#resolveRefresh = res;
			});
		}
		this.#send({ jsonrpc: "2.0", id: this.#rootsRequestId, method: "roots/list" });
	}

	ok(id: number | string, result: unknown): void {
		this.#send({ jsonrpc: "2.0", id, result });
	}

	/**
	 * Error text crosses into the CALLING session, which may paste it into a
	 * commit or an issue, so local paths are stripped at this single boundary.
	 */
	fail(id: number | string, message: unknown, code = -32603): void {
		this.#send({ jsonrpc: "2.0", id, error: { code, message: sanitize(message) } });
	}

	/**
	 * Handle one line of input.
	 *
	 * Malformed input is IGNORED rather than answered with an error: a line that
	 * does not parse has no id to reply to, and inventing one would put a message
	 * on the wire the client never asked for.
	 */
	async handleLine(line: string): Promise<void> {
		const t = String(line ?? "").trim();
		if (!t) return;

		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(t) as JsonRpcMessage;
		} catch {
			return;
		}
		if (msg === null || typeof msg !== "object") return;

		// Handshake complete → ask who is calling. This is a server→client
		// request, so its reply arrives back through this same loop.
		if (msg.method === "notifications/initialized") {
			this.requestRoots();
			return;
		}

		// A response to something WE asked: no method, and an id we issued.
		if (msg.id !== undefined && msg.method === undefined) {
			if (msg.id === this.#rootsRequestId) this.#acceptRoots(msg);
			return;
		}

		// The client may tell us the roots changed mid-session; re-ask.
		if (msg.method === "notifications/roots/list_changed") {
			this.requestRoots();
			return;
		}

		if (msg.id === undefined) return; // any other notification

		const handler = msg.method ? this.#handlers[msg.method] : undefined;
		if (!handler) {
			this.fail(msg.id, `no method ${msg.method}`, -32601);
			return;
		}
		try {
			await handler(msg.id, msg.params);
		} catch (e) {
			this.fail(msg.id, e instanceof Error ? e.message : String(e));
		}
	}

	#acceptRoots(msg: JsonRpcMessage): void {
		const before = this.project;
		const result = msg.result as { roots?: unknown } | undefined;
		this.#roots = Array.isArray(result?.roots) ? (result.roots as Root[]) : [];
		this.#identified = true;
		this.#resolveIdentity();
		// Close the refresh gate: the new roots are in hand.
		this.#resolveRefresh?.();
		this.#refresh = null;
		this.#resolveRefresh = null;
		this.#onIdentified?.(this.#roots);

		// Belt-and-braces for clients that DO re-fetch on this notification.
		// Claude Code did not in testing, which is why the identity WAIT above is
		// the actual mechanism and this is only a courtesy.
		const after = this.project;
		if (after && after !== before) {
			this.#send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
		}
	}
}
