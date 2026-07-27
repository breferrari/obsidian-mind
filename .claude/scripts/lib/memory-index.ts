/**
 * A parse cache over the memory store.
 *
 * `recall` and the duplicate scan read the SAME files and parse the same
 * frontmatter, once per call each. That is linear in the store, and it runs on
 * every recall and every write.
 *
 * WHAT IS CACHED, AND WHAT IS NOT
 *
 * The cache holds the PARSE, never the answer. Every call still lists the store
 * and stats each file; only re-reading and re-parsing a file whose size and
 * mtime are unchanged is skipped. A new or deleted memory is therefore always
 * seen, and an ordinary edit is caught by one of the two.
 *
 * WHAT THIS IS NOT GOOD ENOUGH FOR
 *
 * `(size, mtime)` is a change hint, not a content hash, and the gap is wider
 * than it looks: measured on NTFS, 356 of 400 back-to-back same-size rewrites
 * carried an identical mtimeMs. Anything that sets mtime deliberately — rsync,
 * tar, unzip, a sync client, a restored file version — collides on purpose, and
 * a second-granularity filesystem collides by design. `invalidate()` closes the
 * gap only WITHIN one process, while the deployment shape is one server per
 * consuming repo, all writing into a single vault.
 *
 * So this serves reads, where the cost of being stale is ordering. The duplicate
 * scan reads from disk instead (`storeFresh` in `mcp-server.ts`): a duplicate
 * admitted there is permanent, because nothing downstream ever re-checks.
 *
 * WHY IT IS NOT ON DISK
 *
 * Measured, these walks are a minority of a queried recall — the local query
 * embedding dominates — so persisting the index buys a fraction of one operation
 * while adding a file that can rot, disagree with the store, or need migrating in
 * every vault that ever installed the template. The server is long-lived per
 * repo, so every call after the first is already warm, and a cold start costs
 * what it always did.
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
	/**
	 * Files that exist but could not be re-checked, served from the previous
	 * parse. Counted separately so `hits + misses + stale` always equals what
	 * `all()` returned — a store this server is half-failing to read is otherwise
	 * indistinguishable from a healthy one.
	 */
	readonly stale: number;
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
	all(): MemoryEntry[];
	/** Forget one file by vault-relative path. Called after writing it. */
	invalidate(rel: string): void;
	readonly stats: IndexStats;
}

/**
 * The vault and root are fixed for the life of the index, not passed per call.
 *
 * Keys carry the root prefix, so calling with a different root would evict the
 * whole cache on every alternation — a silent thrash with no error. Binding them
 * at construction makes that impossible rather than merely unlikely.
 */
export function createMemoryIndex(vaultRoot: string, root: string): MemoryIndex {
	let cache = new Map<string, CacheEntry>();
	let hits = 0;
	let misses = 0;
	let stale = 0;

	/**
	 * Synchronous end to end, and it must stay that way: an `invalidate` landing
	 * between the walk and the `cache = next` swap below would be undone by the
	 * swap. Adding an `await` here reintroduces exactly that race.
	 */
	const all = (): MemoryEntry[] => {
		const out: MemoryEntry[] = [];
		// Built fresh each pass and swapped in at the end, so a file that vanished
		// is evicted STRUCTURALLY rather than by a second sweep that has to be kept
		// in step with this loop.
		const next = new Map<string, CacheEntry>();
		hits = 0;
		misses = 0;
		stale = 0;

		for (const f of listMemoryFiles(vaultRoot, root)) {
			const cached = cache.get(f.rel);
			let st: { mtimeMs: number; size: number };
			try {
				st = statSync(f.full);
			} catch (e) {
				// ENOENT means it vanished between listing and stat, and dropping it
				// is right. Any other errno — EACCES, EMFILE, a Windows sharing
				// violation — means the file is still THERE and we merely could not
				// look at it, so a previous parse is better than pretending the
				// memory does not exist. That distinction matters most on the
				// duplicate path, where an omission admits a duplicate permanently.
				if ((e as NodeJS.ErrnoException).code !== "ENOENT" && cached) {
					stale++;
					next.set(f.rel, cached);
					out.push(cached.record);
				}
				continue;
			}

			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				hits++;
				next.set(f.rel, cached);
				out.push(cached.record);
				continue;
			}

			misses++;
			const record = readMemoryFile(f);
			if (!record) {
				// The file is listed and stats fine, so it EXISTS — it just could not
				// be read this instant: a lock, an ACL, a sharing violation, a
				// momentarily exhausted fd table. Those land here far more often than
				// on the stat above, which needs only directory traversal. Keeping
				// the previous parse beats reporting that the memory is gone, and
				// matters most on the duplicate path where an omission is permanent.
				if (cached) {
					stale++;
					next.set(f.rel, cached);
					out.push(cached.record);
				}
				continue;
			}
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
			return { hits, misses, stale, size: cache.size };
		},
	};
}
