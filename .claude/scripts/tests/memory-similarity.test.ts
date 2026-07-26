/**
 * Near-duplicate detection for the vault memory layer.
 *
 * Thresholds here were set from measurement, so the tests pin the measured
 * separation rather than the numbers: a verbatim restatement must be caught, a
 * reworded one must be flagged but not suppressed, and a merely adjacent note
 * must trigger nothing. If a tokenizer change moves any of those, one of these
 * fails.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	tokenize,
	stem,
	jaccard,
	similarity,
	findSimilar,
	sharesFacet,
	DUPLICATE,
} from "../lib/memory-similarity.ts";

describe("tokenizing", () => {
	test("stopwords are dropped, signal is kept", () => {
		const t = tokenize("The patch is not applied to the user's node_modules");
		assert.ok(!t.includes("the"));
		assert.ok(!t.includes("is"));
		assert.ok(t.includes("patch"));
		// `_` survives the markdown pass, so the identifier stays one token;
		// plural folding then trims the trailing s.
		assert.ok(t.includes("node_module"), `identifier was split or lost: ${JSON.stringify(t)}`);
	});

	test("plural folding matches singular and plural without over-stemming", () => {
		assert.equal(stem("patches"), "patch");
		assert.equal(stem("externals"), "external");
		assert.equal(stem("resolves"), "resolve");
		assert.equal(stem("dependencies"), "dependency");
		// Must NOT mangle these — over-stemming collapses distinct technical terms.
		assert.equal(stem("class"), "class");
		assert.equal(stem("https"), "https", "https must not fold into http");
		assert.equal(stem("ios"), "ios");
		assert.equal(stem("css"), "css");
	});

	test("numbers survive — a version difference is the point of a second memory", () => {
		assert.ok(tokenize("breaks in 0.1.5").includes("0.1.5"));
	});

	test("markdown punctuation does not become tokens", () => {
		const t = tokenize("**bold** `code` [link](x) > quote");
		assert.ok(!t.some((x) => x.includes("*") || x.includes("`") || x.includes("[")));
	});

	test("empty and junk input yields no tokens", () => {
		assert.deepEqual(tokenize(""), []);
		assert.deepEqual(tokenize(null), []);
		assert.deepEqual(tokenize("### *** ---"), []);
	});
});

describe("similarity scoring", () => {
	const A = {
		title: "tsup externals decide what a patch can fix",
		body: "patch-package only patches the local node_modules; an external dependency resolves on the user machine so the patch never ships.",
	};

	test("a memory is identical to itself", () => {
		assert.equal(similarity(A, A), 1);
	});

	test("a near-verbatim restatement scores as a duplicate", () => {
		const B = {
			title: "tsup externals decide what patches can fix",
			body: "patch-package patches only the local node_modules; an external dependency resolves on the user machine so a patch never ships.",
		};
		assert.ok(similarity(A, B) >= DUPLICATE, `scored ${similarity(A, B)}`);
	});

	test("a genuinely different lesson about the same subsystem is NOT a duplicate", () => {
		const B = {
			title: "tsup emits no shebang unless banner is set",
			body: "The CLI entry needs a banner in tsup.config so npx can execute dist/cli.js directly.",
		};
		assert.ok(similarity(A, B) < DUPLICATE, `scored ${similarity(A, B)}`);
	});

	test("unrelated memories score near zero", () => {
		const B = { title: "beacon analytics batches on a timer", body: "Events flush every five minutes." };
		assert.ok(similarity(A, B) < 0.2);
	});

	test("title is weighted above body", () => {
		const sameTitle = { title: A.title, body: "completely unrelated prose about kittens and weather." };
		const sameBody = { title: "utterly different heading about kittens", body: A.body };
		assert.ok(similarity(A, sameTitle) > similarity(A, sameBody));
	});

	test("jaccard handles empty bags without dividing by zero", () => {
		assert.equal(jaccard([], []), 1);
		assert.equal(jaccard([], ["a"]), 0);
	});
});

describe("facet gating", () => {
	test("identical text in two unrelated projects is not a duplicate", () => {
		const a = { title: "t", body: "b", scope: "project", projects: ["atlas"] };
		const b = { title: "t", body: "b", scope: "project", projects: ["harbor"] };
		assert.equal(sharesFacet(a, b), false);
		assert.equal(findSimilar(a, [b]).duplicates.length, 0);
	});

	test("a general memory can duplicate anything", () => {
		assert.equal(
			sharesFacet(
				{ title: "t", body: "b", scope: "general", projects: [] },
				{ title: "t", body: "b", scope: "project", projects: ["harbor"] },
			),
			true,
		);
	});

	test("two platform memories on the same platform can duplicate", () => {
		assert.equal(
			sharesFacet(
				{ title: "t", body: "b", scope: "platform", platforms: ["ios"] },
				{ title: "t", body: "b", scope: "platform", platforms: ["ios"] },
			),
			true,
		);
	});

	test("a shared project makes them comparable across scopes", () => {
		assert.equal(
			sharesFacet(
				{ title: "t", body: "b", scope: "project", projects: ["atlas"] },
				{ title: "t", body: "b", scope: "platform", projects: ["atlas"], platforms: ["ios"] },
			),
			true,
		);
	});
});

describe("findSimilar", () => {
	const existing = [
		{
			rel: "memories/2026/07/a.md",
			title: "tsup externals decide what a patch can fix",
			body: "patch-package only patches local node_modules; external deps resolve on the user machine.",
			scope: "general",
		},
		{
			rel: "memories/2026/07/b.md",
			title: "beacon analytics batches on a five minute timer",
			body: "Events are flushed on a timer rather than per event.",
			scope: "general",
		},
	];

	test("a near-restatement is returned as a duplicate with its score", () => {
		const r = findSimilar(
			{
				title: "tsup externals decide what patches can fix",
				body: "patch-package patches only local node_modules; external deps resolve on the user machine.",
				scope: "general",
			},
			existing,
		);
		assert.equal(r.duplicates.length, 1);
		assert.equal(r.duplicates[0]!.entry.rel, "memories/2026/07/a.md");
		assert.ok(r.duplicates[0]!.score >= DUPLICATE);
	});

	test("the same lesson in different words is flagged as a possible restatement", () => {
		const r = findSimilar(
			{
				title: "a patch cannot fix an external dependency",
				body: "Because tsup marks the dependency external it resolves on the user machine, so patching local node_modules never ships anything.",
				scope: "general",
			},
			existing,
		);
		assert.equal(r.duplicates.length, 0, "a rewording is not a duplicate — it may say it better");
		assert.ok(r.related.length >= 1, "but the caller should be told it already knows this");
	});

	test("a merely adjacent note about the same subsystem triggers nothing", () => {
		const r = findSimilar(
			{
				title: "tsup emits no shebang unless banner is set",
				body: "The CLI entry needs a banner in tsup.config so npx can execute dist/cli.js directly.",
				scope: "general",
			},
			existing,
		);
		assert.equal(r.duplicates.length, 0);
		assert.equal(r.related.length, 0);
	});

	test("results are ordered by score", () => {
		const r = findSimilar({ ...existing[0]! }, [...existing, { ...existing[0]!, rel: "c.md" }]);
		for (let i = 1; i < r.duplicates.length; i++) {
			assert.ok(r.duplicates[i - 1]!.score >= r.duplicates[i]!.score);
		}
	});
});
