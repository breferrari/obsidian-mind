/**
 * The server, over real MCP JSON-RPC on stdio.
 *
 * Nothing here imports the modules directly — it spawns the launcher and
 * speaks the protocol, exactly as a client does. That distinction has already
 * earned its keep three times: a query filter that hid what an unfiltered call
 * showed, a recall that returned a path the caller could not open, and a
 * sanitiser that destroyed every URI in every error message. All three passed
 * the unit suites.
 *
 * THE HANDSHAKE IS LOAD-BEARING. A client must advertise the `roots` capability
 * AND send `notifications/initialized`, then answer the server's `roots/list`.
 * Skip any of it and the caller is anonymous, sees only general-scoped
 * memories, and the result is indistinguishable from an empty vault.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(SCRIPTS, "om-mcp.mjs");
const CALLER = "atlas";
const TIMEOUT = 30_000;

interface Rpc {
	id?: number;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code?: number; message?: string };
}

let vault: string;
let child: ChildProcess;
let stderr = "";
const pending = new Map<number, (m: Rpc) => void>();
let nextId = 0;

function put(rel: string, body: string): void {
	const full = join(vault, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
}

const send = (m: unknown): void => {
	child.stdin?.write(JSON.stringify(m) + "\n");
};

function call(method: string, params?: unknown): Promise<Rpc> {
	return new Promise((res, rej) => {
		const id = ++nextId;
		pending.set(id, res);
		send({ jsonrpc: "2.0", id, method, params });
		const t = setTimeout(() => {
			if (pending.delete(id)) rej(new Error(`timeout on ${method}`));
		}, TIMEOUT);
		t.unref?.();
	});
}

const textOf = (r: Rpc): string =>
	String((r.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "");

before(async () => {
	vault = mkdtempSync(join(tmpdir(), "om-int-"));
	put(
		"vault-manifest.json",
		JSON.stringify({ template: "obsidian-mind", qmd_index: "om-int-test", mcp_exposed_roots: ["brain", "reference"] }),
	);
	put("brain/Gotchas.md", '---\ndate: 2026-07-26\ndescription: "things that bit us"\n---\n\n# Gotchas\n\nSee [[Patterns]].\n');
	put("brain/Patterns.md", '---\ndate: 2026-07-26\ndescription: "how we do things"\n---\n\n# Patterns\n\nRelated: [[Gotchas]].\n');
	put("reference/Arch.md", '---\ndate: 2026-07-26\ndescription: "architecture"\n---\n\n# Arch\n');
	// A spaced filename, because that is what qmd slugifies and therefore the only
	// fixture that exercises the resource-URI repair end to end.
	put(
		"reference/Design Notes.md",
		'---\ndate: 2026-07-26\ndescription: "design notes"\n---\n\n# Design Notes\n',
	);
	// A promoted lesson, anchored, in an EXPOSED root — plus a corrected twin in
	// an UNEXPOSED one, so the policy gate is exercised over the wire rather
	// than only in the unit suite.
	put(
		"brain/Gotchas - Promoted.md",
		'---\ndate: 2026-07-26\ndescription: "promoted lessons"\n---\n\n' +
			"# Gotchas - Promoted\n\n" +
			"- **The corrected version.** Swept after a later measurement proved the first wording wrong. ^om-corrected\n" +
			"- **Another entry.** Unrelated to the one above.\n",
	);
	put("work/Confidential Promoted.md", "# Confidential\n\n- **Must not travel.** Private. ^om-private\n");
	put("work/Secret.md", '---\ndate: 2026-07-26\ndescription: "CONFIDENTIAL"\n---\n\n# Secret\n');
	put("work/atlas.md", "---\ndate: 2026-07-26\nplatforms: [ios]\n---\n\n# atlas\n");

	child = spawn(process.execPath, [LAUNCHER], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OM_VAULT_PATH: vault },
	});
	child.stderr?.on("data", (d) => (stderr += String(d)));

	let buf = "";
	child.stdout?.on("data", (d) => {
		buf += String(d);
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg: Rpc;
			try {
				msg = JSON.parse(line) as Rpc;
			} catch {
				continue;
			}
			// The server asking who we are. Answering is what makes this session
			// identified rather than anonymous.
			if (msg.method === "roots/list") {
				send({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: `file:///C:/Dev/${CALLER}` }] } });
				continue;
			}
			if (msg.method) continue;
			const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
			if (p && msg.id !== undefined) {
				pending.delete(msg.id);
				p(msg);
			}
		}
	});

	const init = await call("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: { roots: { listChanged: true } },
		clientInfo: { name: "integration", version: "1" },
	});
	assert.equal((init.result?.serverInfo as { name?: string })?.name, "om");
	send({ jsonrpc: "2.0", method: "notifications/initialized" });
	await new Promise((r) => setTimeout(r, 300));
});

after(() => {
	child?.kill();
	if (vault) rmSync(vault, { recursive: true, force: true });
});

describe("the om server on the wire", () => {
	test("the contract reaches the calling session", async () => {
		const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
		const instructions = String(init.result?.instructions ?? "");
		assert.match(instructions, /personal knowledge vault/);
		assert.match(instructions, /Claude-Session:/, "the prohibition is the half that actually propagates");
	});

	test("every tool is declared with behaviour annotations", async () => {
		const r = await call("tools/list");
		const tools = (r.result?.tools ?? []) as { name: string; annotations?: Record<string, unknown> }[];
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["expand", "health", "reason", "recall", "record_work", "remember", "search"]);
		for (const t of tools) {
			assert.ok(t.annotations, `${t.name} must annotate so a client can pick without trial-and-error`);
		}
		// `reason` starts a process and calls a model, so a client choosing between
		// tools must be able to tell it apart from a local read without trying it.
		const reason = tools.find((t) => t.name === "reason");
		assert.equal(reason?.annotations?.openWorldHint, true, "reason reaches outside this process");
		assert.equal(reason?.annotations?.idempotentHint, false, "same question, different answer");
	});

	test("reason refuses an empty question without spawning anything", async () => {
		// This suite must never hand `reason` a real question — that would start a
		// second Claude session from a unit test. The empty-question path is the one
		// refusal reachable without spawning, and it proves the handler is wired.
		const out = textOf(await call("tools/call", { name: "reason", arguments: { question: "   " } }));
		assert.match(out, /Not run:/);
		assert.match(out, /no question/);
	});

	test("the resource listing honours the policy — work/ never appears", async () => {
		const r = await call("resources/list");
		const uris = ((r.result?.resources ?? []) as { uri: string }[]).map((x) => x.uri);
		assert.equal(uris.length, 5); // brain x3, reference x2
		assert.ok(!uris.some((u) => u.toLowerCase().includes("work")), uris.join(" "));
		assert.ok(!uris.some((u) => u.toLowerCase().includes("secret")), uris.join(" "));
		// The promoted-target fixture in work/ is the one that matters here: it is
		// reachable through a `promoted:` marker, and it must still be absent from
		// every enumerating surface.
		assert.ok(!uris.some((u) => u.toLowerCase().includes("confidential")), uris.join(" "));
	});

	test("an exposed note reads back", async () => {
		const r = await call("resources/read", { uri: "vault://note/brain/Gotchas.md" });
		const contents = (r.result?.contents ?? []) as { text?: string }[];
		assert.match(String(contents[0]?.text), /# Gotchas/);
	});

	// A URI minted by `resources/list` must survive a round trip unchanged.
	// `resources/read` returns the CANONICAL uri rather than echoing the request,
	// so if the two ever encoded differently every read would silently hand back a
	// uri the caller did not ask for. They are built the same way today; this is
	// what keeps that true.
	test("a listed URI reads back with the same URI", async () => {
		const list = await call("resources/list");
		const uri = ((list.result?.resources ?? []) as { uri: string }[]).find((x) =>
			x.uri.includes("Design"),
		)!.uri;
		assert.match(uri, /%20/, "sanity: the listed uri is percent-encoded");

		const r = await call("resources/read", { uri });
		const contents = (r.result?.contents ?? []) as { uri?: string; text?: string }[];
		assert.equal(contents[0]?.uri, uri, "the uri came back unchanged");
		assert.match(String(contents[0]?.text), /# Design Notes/);
	});

	// qmd reports paths PREFIXED with the collection name and with spaces turned
	// into dashes. Both forms are unit-tested against the resolver directly; these
	// two go over the wire, because the resolver could be perfect while the server
	// forgot to pass the collection through — every unit test would still pass and
	// the feature would be dead in production.
	test("a collection-prefixed URI resolves, so the collection reaches the resolver", async () => {
		const r = await call("resources/read", {
			uri: "vault://note/om-int-test/reference/Design%20Notes.md",
		});
		const contents = (r.result?.contents ?? []) as { uri?: string; text?: string }[];
		assert.match(String(contents[0]?.text), /# Design Notes/, JSON.stringify(r.error ?? {}));
		assert.equal(contents[0]?.uri, "vault://note/reference/Design%20Notes.md", "canonical uri returned");
	});

	test("a slugified URI resolves and comes back canonical", async () => {
		const r = await call("resources/read", {
			uri: "vault://note/om-int-test/reference/Design-Notes.md",
		});
		const contents = (r.result?.contents ?? []) as { uri?: string; text?: string }[];
		assert.match(String(contents[0]?.text), /# Design Notes/, JSON.stringify(r.error ?? {}));
		assert.equal(
			contents[0]?.uri,
			"vault://note/reference/Design%20Notes.md",
			"the caller learns the uri that works directly",
		);
	});

	test("an unserved note is refused, and the error keeps the URI intact", async () => {
		const r = await call("resources/read", { uri: "vault://note/work/Secret.md" });
		assert.ok(r.error, "must refuse");
		// Regression: the sanitiser matched "t://note/..." as a drive path and
		// returned "vaul<path>", destroying every URI in every error message.
		assert.match(String(r.error?.message), /vault:\/\/note\/work\/Secret\.md/);
	});

	test("expand walks the graph", async () => {
		const r = await call("tools/call", { name: "expand", arguments: { note: "Gotchas" } });
		assert.match(textOf(r), /Patterns/);
	});

	test("health names the caller and its platforms", async () => {
		const r = await call("tools/call", { name: "health", arguments: {} });
		const t = textOf(r);
		assert.match(t, new RegExp(`Caller: ${CALLER}`));
		// The platform comes from work/atlas.md, which is OUTSIDE the exposure
		// fence — proof the caller-identity lookup is not scoped by it.
		assert.match(t, /Platforms: ios/);
	});

	test("health reports the day's reasoning usage, which is what replaces a cap", async () => {
		// Nothing bounds `reason`, so this line is the entire answer to "where did
		// that usage go". If it stops being reported, the argument for having no
		// cap stops holding — hence a test rather than a docstring.
		const t = textOf(await call("tools/call", { name: "health", arguments: {} }));
		assert.match(t, /Reasoning today: /);
		// No spawn has happened in this suite, so it must say so rather than omit
		// the line — an absent line reads as "not tracked".
		assert.match(t, /Reasoning today: nothing yet today/);
		// And it names the model that a call would actually use.
		assert.match(t, /model: your CLI default/);
	});

	test("recall on an empty store explains itself rather than returning nothing", async () => {
		const r = await call("tools/call", { name: "recall", arguments: { explain: true } });
		const t = textOf(r);
		assert.match(t, /No memories are scoped to reach "atlas"/);
		assert.match(t, /health/, "a dead end must point at the diagnostic");
	});

	test("remember previews without writing", async () => {
		const r = await call("tools/call", {
			name: "remember",
			arguments: {
				title: "an integration lesson about token expiry",
				body: "Recorded by the integration test to prove the write path renders a real note.",
				confidence: "verified",
				verification: "observed directly in this run",
				scope: "project",
				projects: [CALLER],
				dry_run: true,
			},
		});
		const t = textOf(r);
		assert.match(t, /Preview \(nothing written\)/);
		assert.match(t, /source: mcp-capture/, "the rendered note carries its provenance");
	});

	test("an unknown tool is an error, not a silent success", async () => {
		const r = await call("tools/call", { name: "nope", arguments: {} });
		assert.ok(r.error);
		assert.equal(r.error?.code, -32602);
	});

	test("prompts are offered and render an instruction", async () => {
		const list = await call("prompts/list");
		assert.equal(((list.result?.prompts ?? []) as unknown[]).length, 2);
		const got = await call("prompts/get", { name: "prior_art", arguments: { question: "should we cache this" } });
		const messages = (got.result?.messages ?? []) as { content?: { text?: string } }[];
		assert.match(String(messages[0]?.content?.text), /should we cache this/);
	});

	test("record_work files a note and refuses an undeclared destination", async () => {
		const ok = await call("tools/call", {
			name: "record_work",
			arguments: {
				title: "Wire up the archive command",
				summary: "Added the archive command behind a flag, with the reasoning recorded.",
				changes: ["src/store.ts - added a pure archive()"],
				informed_by: ["Gotchas", "A Note That Does Not Exist"],
				folder: "brain",
			},
		});
		const t = textOf(ok);
		assert.match(t, /Recorded: brain\//);

		const filed = readFileSync(join(vault, t.split("\n")[0]!.replace("Recorded: ", "")), "utf8");
		assert.match(filed, /source_repo: atlas/, "provenance is derived, not asserted by the caller");
		assert.match(filed, /- \[\[Gotchas\]\]/, "a resolvable reference becomes a link");
		assert.match(filed, /_\(no note yet\)_/, "an unresolvable one must NOT become a broken link");

		// The exposed roots bound writes too, not only reads.
		const denied = await call("tools/call", {
			name: "record_work",
			arguments: { title: "sneak", summary: "should not land", folder: "work" },
		});
		assert.match(textOf(denied), /Not recorded:.*not inside an exposed root/);
		assert.ok(!existsSync(join(vault, "work", "sneak.md")));
	});

	test("a memory written through remember comes back through recall", async () => {
		// The whole point of the layer, asserted end to end over the wire: a write
		// that cannot be read back is not a memory, and both halves must agree
		// about scope without either being told what the other did.
		const wrote = await call("tools/call", {
			name: "remember",
			arguments: {
				title: "tsup externals decide what a patch can fix",
				body: "A dependency marked external is resolved on the user's machine at install time, so a local patch never reaches them.",
				confidence: "verified",
				verification: "Checked the built artifact directly.",
				scope: "project",
				projects: [CALLER],
			},
		});
		assert.match(textOf(wrote), /Recorded: memories\//);

		const back = await call("tools/call", { name: "recall", arguments: {} });
		const t = textOf(back);
		assert.match(t, /tsup externals decide what a patch can fix/);
		assert.match(t, /verified/, "the confidence marker survives the round trip");

		// Writing the same lesson again must be caught rather than duplicated.
		const dup = await call("tools/call", {
			name: "remember",
			arguments: {
				title: "tsup externals decide what a patch can fix",
				body: "A dependency marked external is resolved on the user's machine at install time, so a local patch never reaches them.",
				confidence: "verified",
				verification: "Checked the built artifact directly.",
				scope: "project",
				projects: [CALLER],
			},
		});
		assert.match(textOf(dup), /near-identical memory already exists/);
	});

	/**
	 * Promotion, over the wire.
	 *
	 * The unit suite proves the resolver. What only a live server proves is that
	 * a foreign caller actually RECEIVES the corrected text — the surface a
	 * promoted lesson is otherwise invisible on — and that the exposure policy
	 * still holds when the read crosses out of the memory root for the first
	 * time.
	 */
	describe("a promoted memory", () => {
		const memory = (name: string, promoted: string, body: string): void =>
			put(
				`memories/2026/07/${name}.md`,
				"---\n" +
					`description: "${body}"\n` +
					"tags: [memory]\n" +
					"source: mcp-capture\n" +
					`origin: "${CALLER}"\n` +
					"scope: project\n" +
					`projects: [${CALLER}]\n` +
					"confidence: verified\n" +
					`promoted: "${promoted}"\n` +
					"---\n\n" +
					`# ${name}\n\n${body}\n`,
			);

		test("the corrected text is served instead of the capture as first written", async () => {
			memory("anchored-lesson", "brain/Gotchas - Promoted#^om-corrected", "THE STALE ORIGINAL WORDING");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 50 } }));
			assert.match(t, /Swept after a later measurement/, "the promoted text must reach the caller");
			assert.doesNotMatch(t, /THE STALE ORIGINAL WORDING/, "the superseded capture body must not be shown");
			assert.match(t, /promoted text from brain\/Gotchas - Promoted\.md#\^om-corrected/);
		});

		test("a target outside the exposed roots is named but its content never travels", async () => {
			memory("unexposed-lesson", "work/Confidential Promoted#^om-private", "CAPTURE BODY FOR UNEXPOSED");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 50 } }));
			assert.doesNotMatch(t, /Must not travel/, "content outside the exposed roots must never be served");
			assert.match(t, /outside the exposed roots/);
			assert.match(t, /CAPTURE BODY FOR UNEXPOSED/, "the capture is still served");
		});

		test("a bare marker keeps the pre-existing behaviour", async () => {
			memory("bare-marker", "brain/Gotchas - Promoted", "CAPTURE BODY FOR BARE");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 50 } }));
			assert.match(t, /CAPTURE BODY FOR BARE/);
			assert.match(t, /no anchor; capture body shown/);
			assert.doesNotMatch(t, /Another entry\./, "a bare marker must not widen to the whole note");
		});

		test("a stale anchor degrades to the capture and says so", async () => {
			memory("stale-anchor", "brain/Gotchas - Promoted#^om-gone", "CAPTURE BODY FOR STALE");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 50 } }));
			assert.match(t, /CAPTURE BODY FOR STALE/);
			assert.match(t, /anchor \^om-gone STALE/);
			assert.doesNotMatch(t, /Another entry\./);
		});

		/**
		 * The decay has to reach the party that can fix it (#183).
		 *
		 * `recall` has reported `stale-anchor` since v8.3.0, and it reports it to a
		 * FOREIGN repo — which cannot see `brain/` at all and so cannot re-point
		 * the marker. A vault session drops a `^om-…` id, every recall elsewhere
		 * silently downgrades to the raw capture, and nothing in the vault says so.
		 * `health` is the surface a vault session reads, so it is where this lands.
		 */
		test("health warns about the broken promotion, and never about a bare one", async () => {
			memory("health-stale", "brain/Gotchas - Promoted#^om-gone", "CAPTURE BODY FOR STALE");
			memory("health-bare", "brain/Gotchas - Promoted", "CAPTURE BODY FOR BARE");
			memory("health-ok", "brain/Gotchas - Promoted#^om-corrected", "STALE ORIGINAL");

			const t = textOf(await call("tools/call", { name: "health", arguments: {} }));

			assert.match(t, /Warnings:/);
			assert.match(t, /health-stale/, "the CAPTURE is named — it is the file to edit");
			assert.match(t, /anchor no longer resolves/);
			assert.doesNotMatch(
				t,
				/health-bare/,
				"a bare marker is a legitimate promotion, never a warning",
			);

			// Counted rather than warned, so a store where nothing is servable is
			// distinguishable from one where everything is — the hygiene flag falls
			// either way, which is what made the difference invisible.
			assert.match(t, /Promotions: \d+ servable, \d+ named only/);
			assert.match(t, /add an anchor/);
		});

		/**
		 * The shapes that were served WRONG before the segmenter, over the wire.
		 *
		 * Each of these returned something a reader would not call the promoted
		 * entry, while reporting success. They are here rather than only in the
		 * unit suite because the property is what a foreign session RECEIVES.
		 */
		test("a multi-line bullet anchored at its end serves the whole bullet", async () => {
			const N = String.fromCharCode(10);
			put(
				"brain/Multi.md",
				"# M" + N + N + "- **The lesson subject.** First line of it." + N + "  and the second line that completes it. ^om-multi" + N,
			);
			memory("multiline-block", "brain/Multi#^om-multi", "STALE CAPTURE BODY");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 60 } }));
			assert.match(t, /The lesson subject/, "the bullet's own subject must survive");
			assert.match(t, /second line that completes it/);
			assert.doesNotMatch(t, /STALE CAPTURE BODY/);
			assert.doesNotMatch(t, /TRUNCATED/, "two of two lines is not a truncation");
		});

		test("an ordered-list item serves itself and not its siblings", async () => {
			const N = String.fromCharCode(10);
			put(
				"brain/Ordered.md",
				"# O" + N + N + "1. First lesson." + N + "2. Second lesson. ^om-two" + N + "3. Third lesson." + N + "4. Fourth lesson." + N,
			);
			memory("ordered-block", "brain/Ordered#^om-two", "CAPTURE FOR ORDERED");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 60 } }));
			assert.match(t, /Second lesson/);
			assert.doesNotMatch(t, /Third lesson/, "a sibling item is a different lesson");
			assert.doesNotMatch(t, /Fourth lesson/);
		});

		test("an indented alone-id serves the paragraph above it, not the text below", async () => {
			const N = String.fromCharCode(10);
			put(
				"brain/Indent.md",
				"# I" + N + N + "  THE PROMOTED LESSON, corrected." + N + "  ^om-ind" + N + "  AN UNRELATED PARAGRAPH." + N,
			);
			memory("indented-alone", "brain/Indent#^om-ind", "CAPTURE FOR INDENT");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 60 } }));
			assert.match(t, /THE PROMOTED LESSON/);
			assert.doesNotMatch(t, /AN UNRELATED PARAGRAPH/);
		});

		test("a documentation decoy inside a fence never wins", async () => {
			const N = String.fromCharCode(10);
			put(
				"brain/Decoy.md",
				"# D" + N + N + "```md" + N + "- DOC EXAMPLE ^om-dec" + N + "```" + N + N + "- **The real entry.** ^om-dec" + N,
			);
			memory("fence-decoy", "brain/Decoy#^om-dec", "CAPTURE FOR DECOY");
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 60 } }));
			assert.match(t, /The real entry/);
			assert.doesNotMatch(t, /DOC EXAMPLE/);
		});

		test("under load: many promoted memories stay correct and bounded", async () => {
			for (let i = 0; i < 120; i++) {
				memory(`bulk-${i}`, "brain/Gotchas - Promoted#^om-corrected", `BULK CAPTURE ${i}`);
			}
			const started = Date.now();
			const t = textOf(await call("tools/call", { name: "recall", arguments: { limit: 60 } }));
			const ms = Date.now() - started;

			// The limit is honoured under load rather than the whole store spilling.
			const served = t.match(/promoted text from brain\/Gotchas - Promoted/g) ?? [];
			assert.ok(served.length > 0, "promoted text is served under load");
			assert.ok(served.length <= 60, `limit honoured, got ${served.length}`);
			// Every served entry shows the corrected text, so the note cache cannot
			// have served one entry's content to another.
			assert.doesNotMatch(t, /BULK CAPTURE \d+[\s\S]{0,80}THE STALE/);
			assert.ok(ms < 20_000, `recall over 120+ promoted memories took ${ms}ms`);
		});
	});

	test("ping works", async () => {
		assert.ok((await call("ping")).result);
	});

	test("STDERR STAYS EMPTY — a stray byte on the wire corrupts the stream", () => {
		assert.equal(stderr.trim(), "", stderr.slice(0, 400));
	});
});
