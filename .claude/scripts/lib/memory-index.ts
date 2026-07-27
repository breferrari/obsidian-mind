/**
 * A parse cache over the memory store.
 *
 * `recall` and the duplicate scan read the SAME files and parse the same
 * frontmatter, once per call each. At a thousand memories that is ~200ms per
 * operation, linear in the store, and it runs on every recall and every write.
 *
 * WHAT IS CACHED, AND WHAT IS NOT
 *
 * The cache holds the PARSE, never the answer. Every call still lists the store
 * and stats each file; only re-reading and re-parsing a file whose size and
 * mtime are unchanged is skipped. So a memory written a second ago is always
 * seen, which is what makes this safe on the duplicate-check path — a stale view
 * there would let a genuine duplicate through, and duplicates are the failure
 * this store is least able to recover from.
 *
 * Size AND mtime, because either alone is weak: some filesystems keep mtime to a
 * whole second, and an edit that preserves length is not hypothetical here
 * (marking a memory superseded rewrites frontmatter in place). Writers also
 * `invalidate()` explicitly, so correctness never rests on timestamp resolution.
 *
 * WHY IT IS NOT ON DISK
 *
 * Measured, these walks are ~300 ms of a ~3,000 ms queried recall — the local
 * query embedding dominates — so persisting the index buys a fraction of one
 * operation while adding a file that can rot, disagree with the store, or need
 * migrating in every vault that ever installed the template. The server is
 * long-lived per repo, so every call after the first is already warm, and a cold
 * start costs exactly what it costs today.
 */

import { statSync } from "node:fs";

import { listMemoryFiles, readMemoryFile, type MemoryEntry } from "./memory-recall.ts";

interface CacheEntry {
	readonly mtimeMs: number;
	readonly size: number;
	readonly record: MemoryEntry;
}

export interface IndexStats {
	/** Files served from cache by the last `all()`. */
	readonly hits: number;
	/** Files read and parsed by the last `all()`. */
	readonly misses: number;
	/** Entries currently held. */
	readonly size: number;
}

export interface MemoryIndex {
	/**
	 * Every file in the store, parsed. Unchanged files come from cache.
	 *
	 * Returns agent-written memories and human notes alike — the caller decides,
	 * because "is this a memory" is a policy question and a cache that answers it
	 * would have to be rebuilt whenever the policy moved.
	 */
	all(vaultRoot: string, root: string): MemoryEntry[];
	/** Forget one file by vault-relative path. Called after writing it. */
	invalidate(rel: string): void;
	readonly stats: IndexStats;
}

export function createMemoryIndex(): MemoryIndex {
	let cache = new Map<string, CacheEntry>();
	let hits = 0;
	let misses = 0;

	const all = (vaultRoot: string, root: string): MemoryEntry[] => {
		const out: MemoryEntry[] = [];
		// Built fresh each pass and swapped in at the end, so a file that vanished
		// is evicted STRUCTURALLY rather than by a second sweep that has to be kept
		// in step with this loop.
		const next = new Map<string, CacheEntry>();
		hits = 0;
		misses = 0;

		for (const f of listMemoryFiles(vaultRoot, root)) {
			let st: { mtimeMs: number; size: number };
			try {
				st = statSync(f.full);
			} catch {
				continue; // vanished between listing and stat
			}

			const cached = cache.get(f.rel);
			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				hits++;
				next.set(f.rel, cached);
				out.push(cached.record);
				continue;
			}

			misses++;
			// An unreadable file must not take down retrieval, and must not leave a
			// stale parse behind pretending it is still readable — dropping it is
			// automatic here, since it simply never enters `next`.
			const record = readMemoryFile(f);
			if (!record) continue;
			next.set(f.rel, { mtimeMs: st.mtimeMs, size: st.size, record });
			out.push(record);
		}

		cache = next;
		return out;
	};

	return {
		all,
		invalidate: (rel) => {
			cache.delete(rel);
		},
		get stats(): IndexStats {
			return { hits, misses, size: cache.size };
		},
	};
}
