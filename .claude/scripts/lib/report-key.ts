/**
 * A stable identity for a hook's report, so a hook that fires every turn can
 * tell "the same findings" from "new findings" (#252).
 *
 * Two things change with no new drift to act on, and both are removed before
 * hashing:
 *
 *  - Volatile values, named by the caller: a note's size, an item's age. They
 *    stay in the message the user reads, but not in its identity, or a note
 *    the agent keeps appending to would re-show the report every turn.
 *  - The ORDER those values impose. The scans sort findings by size or age,
 *    so dropping the value alone is not enough: with two oversized notes,
 *    growing the smaller one past the larger reorders the list and changes
 *    the hash all the same. Every array is put in a canonical order first.
 *
 * Objects lose their volatile keys and are key-sorted; arrays are sorted by
 * the canonical text of their elements. Two reports with the same findings in
 * any order, at any size or age, hash the same.
 */

import { createHash } from "node:crypto";

/** `value` with volatile keys removed and every object and array in canonical order. */
export function canonical(value: unknown, volatile: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) {
		return value
			.map((item) => canonical(item, volatile))
			.map((item) => [JSON.stringify(item), item] as const)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, item]) => item);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			if (volatile.has(key)) continue;
			out[key] = canonical((value as Record<string, unknown>)[key], volatile);
		}
		return out;
	}
	return value;
}

/** A short hash of `value`'s canonical form: equal for reports with the same findings. */
export function reportKey(value: unknown, volatile: ReadonlySet<string>): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value, volatile)))
		.digest("hex")
		.slice(0, 16);
}
