/**
 * Framing and the identity handshake.
 *
 * The handshake is the reason this file is a class rather than module state.
 * The prototype kept the caller's roots in module scope, which made the
 * identity race untestable — so it took a live client to find that
 * `resources/list` arrives BEFORE the server knows who is asking, and that
 * announcing a list-changed notification afterwards does not make the client
 * re-fetch. A scoping layer that answers before it knows the caller is not a
 * scoping layer.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { McpSession, type Handlers } from "../lib/mcp-protocol.ts";

interface Sent {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	result?: unknown;
	error?: { code?: number; message?: string };
}

function session(handlers: Handlers = {}, identityTimeoutMs = 50) {
	const sent: Sent[] = [];
	const s = new McpSession({ send: (m) => sent.push(m as Sent), handlers, identityTimeoutMs });
	return { s, sent };
}

const ROOT = "file:///C:/Dev/atlas";

/** Drive a full handshake and return the session. */
async function handshaken(handlers: Handlers = {}, uri = ROOT) {
	const { s, sent } = session(handlers);
	await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
	const ask = sent.find((m) => m.method === "roots/list");
	await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask!.id, result: { roots: [{ uri }] } }));
	return { s, sent };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe("framing", () => {
	test("dispatches a request to its handler and replies with the result", async () => {
		const { s, sent } = session({ ping: (id) => s.ok(id, { pong: true }) });
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
		assert.deepEqual(sent, [{ jsonrpc: "2.0", id: 1, result: { pong: true } }]);
	});

	test("blank and malformed lines are IGNORED, never answered", async () => {
		// A line that does not parse has no id to reply to, so inventing one puts
		// a message on the wire the client never asked for.
		const { s, sent } = session();
		for (const line of ["", "   ", "\n", "not json", "{oops", "null", "[1,2]"]) {
			await s.handleLine(line);
		}
		assert.deepEqual(sent, []);
	});

	test("an unknown method returns method-not-found", async () => {
		const { s, sent } = session();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "nope" }));
		assert.equal(sent[0]!.error?.code, -32601);
		assert.match(String(sent[0]!.error?.message), /no method nope/);
	});

	test("a notification with no id gets no reply", async () => {
		const { s, sent } = session({ ping: () => assert.fail("must not run") });
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/something" }));
		assert.deepEqual(sent, []);
	});

	test("a throwing handler becomes an error response, not a crash", async () => {
		const { s, sent } = session({
			boom: () => {
				throw new Error("kaboom");
			},
		});
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "boom" }));
		assert.equal(sent[0]!.error?.code, -32603);
		assert.match(String(sent[0]!.error?.message), /kaboom/);
	});

	test("a rejecting async handler is caught the same way", async () => {
		const { s, sent } = session({ boom: async () => Promise.reject(new Error("async kaboom")) });
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "boom" }));
		assert.match(String(sent[0]!.error?.message), /async kaboom/);
	});

	test("an error message carrying a local path is sanitised before it leaves", async () => {
		// Error text lands in the calling session and may be pasted into a commit.
		const { s, sent } = session({
			boom: () => {
				throw new Error("ENOENT, lstat 'C:\\Users\\someone\\vault\\a.md'");
			},
		});
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "boom" }));
		const msg = String(sent[0]!.error?.message);
		assert.ok(!msg.includes("someone"), msg);
		assert.match(msg, /<path>/);
	});

	test("an id of 0 is a real id, not a missing one", async () => {
		const { s, sent } = session({ ping: (id) => s.ok(id, "ok") });
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.id, 0);
	});

	test("a string id round-trips unchanged", async () => {
		const { s, sent } = session({ ping: (id) => s.ok(id, "ok") });
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "ping" }));
		assert.equal(sent[0]!.id, "abc");
	});
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("the identity handshake", () => {
	test("initialized triggers a roots request", async () => {
		const { s, sent } = session();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const ask = sent.find((m) => m.method === "roots/list");
		assert.ok(ask, "the server must ask who is calling");
		assert.ok(typeof ask!.id === "number" && ask!.id >= 10_000, "server ids must not collide with the client's");
	});

	test("the roots reply establishes the caller", async () => {
		const { s } = await handshaken();
		assert.equal(s.identified, true);
		assert.equal(s.project, "atlas");
	});

	test("a caller that never answers stays ANONYMOUS rather than hanging", async () => {
		// The cap is the whole point: an unhelpful answer beats a hung server.
		const { s } = session({}, 10);
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		await s.identityReady();
		assert.equal(s.identified, false);
		assert.equal(s.project, null, "anonymous — and downstream that means general-scope only");
	});

	test("identityReady resolves immediately once identity is known", async () => {
		const { s } = await handshaken();
		// A 50ms cap would make this measurably slow if it were still racing.
		const before = process.hrtime.bigint();
		await s.identityReady();
		const ms = Number(process.hrtime.bigint() - before) / 1e6;
		assert.ok(ms < 20, `resolved in ${ms}ms`);
	});

	test("a scope-dependent request waits for identity before it is served", async () => {
		// This is the race: resources/list arrives before roots/list comes back.
		const order: string[] = [];
		const { s, sent } = session({
			"resources/list": async (id) => {
				await s.identityReady();
				order.push(`served:${s.project}`);
				s.ok(id, { resources: [] });
			},
		});
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const pending = s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }));
		const ask = sent.find((m) => m.method === "roots/list");
		order.push("roots-answered");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask!.id, result: { roots: [{ uri: ROOT }] } }));
		await pending;
		assert.deepEqual(order, ["roots-answered", "served:atlas"], "the listing must not be served unscoped");
	});

	test("an empty roots reply is identified-but-anonymous", async () => {
		const { s, sent } = session();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const ask = sent.find((m) => m.method === "roots/list");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask!.id, result: { roots: [] } }));
		assert.equal(s.identified, true);
		assert.equal(s.project, null);
	});

	test("a malformed roots reply does not poison the session", async () => {
		const { s, sent } = session();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const ask = sent.find((m) => m.method === "roots/list");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask!.id, result: { roots: "not an array" } }));
		assert.deepEqual(s.roots, []);
		assert.equal(s.project, null);
	});

	test("a response to an id we did NOT issue is ignored", async () => {
		const { s, sent } = session();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { roots: [{ uri: ROOT }] } }));
		assert.equal(s.identified, false, "a stray response must not establish identity");
		assert.equal(s.project, null);
	});

	test("establishing a caller announces list_changed", async () => {
		const { sent } = await handshaken();
		assert.ok(sent.some((m) => m.method === "notifications/resources/list_changed"));
	});

	test("roots changing mid-session re-asks and rescopes", async () => {
		const { s, sent } = await handshaken();
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }));
		const asks = sent.filter((m) => m.method === "roots/list");
		assert.equal(asks.length, 2, "a changed root must be re-read, not assumed stable");
		await s.handleLine(
			JSON.stringify({ jsonrpc: "2.0", id: asks[1]!.id, result: { roots: [{ uri: "file:///C:/Dev/beacon" }] } }),
		);
		assert.equal(s.project, "beacon");
	});

	test("a request during a roots REFRESH waits for the new identity", async () => {
		// The stale-identity race, one step later in the lifecycle than the first
		// one. Identity was already established, so identityReady() returned
		// immediately and a call arriving between the list_changed notification
		// and the roots reply was served as the PREVIOUS project — the wrong
		// scope, silently.
		const served: string[] = [];
		const { s, sent } = session({
			"tools/call": async (id) => {
				await s.identityReady();
				served.push(String(s.project));
				s.ok(id, {});
			},
		});
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const first = sent.find((m) => m.method === "roots/list");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: first!.id, result: { roots: [{ uri: ROOT }] } }));
		assert.equal(s.project, "atlas");

		// Client says the roots changed; a call races the re-fetch.
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }));
		const pending = s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call" }));
		const second = sent.filter((m) => m.method === "roots/list")[1];
		await s.handleLine(
			JSON.stringify({ jsonrpc: "2.0", id: second!.id, result: { roots: [{ uri: "file:///C:/Dev/beacon" }] } }),
		);
		await pending;
		assert.deepEqual(served, ["beacon"], "must be served as the NEW project, never the old one");
	});

	test("a refresh the client never answers still releases, as anonymous-ish", async () => {
		// The cap has to apply to the refresh gate too, or a client that announces
		// a change and never answers hangs every subsequent call.
		const { s, sent } = session({}, 30);
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const first = sent.find((m) => m.method === "roots/list");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: first!.id, result: { roots: [{ uri: ROOT }] } }));
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }));
		await s.identityReady(); // must not hang
		assert.equal(s.project, "atlas", "the last known identity stands rather than going blank");
	});

	test("the onIdentified hook fires with the roots", async () => {
		const seen: string[] = [];
		const sent: Sent[] = [];
		const s = new McpSession({
			send: (m) => sent.push(m as Sent),
			handlers: {},
			onIdentified: (roots) => seen.push(...roots.map((r) => String(r.uri))),
		});
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		const ask = sent.find((m) => m.method === "roots/list");
		await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ask!.id, result: { roots: [{ uri: ROOT }] } }));
		assert.deepEqual(seen, [ROOT]);
	});

	test("two sessions do not share identity", async () => {
		// The prototype kept this in module scope, which is what made the race
		// impossible to test in the first place.
		const a = await handshaken({}, "file:///C:/Dev/atlas");
		const b = await handshaken({}, "file:///C:/Dev/beacon");
		assert.equal(a.s.project, "atlas");
		assert.equal(b.s.project, "beacon");
	});
});
