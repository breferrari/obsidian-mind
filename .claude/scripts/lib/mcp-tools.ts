/**
 * Tool declarations.
 *
 * These descriptions are not documentation — they are the ONLY thing the model
 * reads when deciding whether to call a tool, so they are written as
 * instructions to that decision rather than as summaries of behaviour. Two
 * measured lessons shape them:
 *
 * 1. A tool is skipped whenever a nearer source of the answer exists. So each
 *    description says WHEN to reach for it, not merely what it does.
 * 2. `remember` and `record_work` are constantly confused, and a store filling
 *    with "what I did today" is worse than an empty one. The distinction is
 *    stated as a TEST the model can apply ("would this help someone on a
 *    different project?") rather than as a definition.
 *
 * `annotations` let a client pick a tool without trial-and-error and let a
 * permission layer auto-approve the read-only ones. Omitting them was an
 * oversight in the first prototype.
 */

export interface ToolDef {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly annotations: {
		readonly title: string;
		readonly readOnlyHint: boolean;
		readonly destructiveHint: boolean;
		readonly idempotentHint: boolean;
		readonly openWorldHint: boolean;
	};
}

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const TOOLS: readonly ToolDef[] = [
	{
		name: "search",
		description:
			"Semantic + keyword search over the user's personal knowledge vault. Returns ranked passages with note paths. Fast and free — prefer this over asking the user to recall something.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look for" },
				limit: { type: "number", description: "Max results (default 5)" },
			},
			required: ["query"],
		},
		annotations: { title: "Search the personal vault", ...READ_ONLY },
	},
	{
		name: "expand",
		description:
			"Given a note you already know, show what it links to and what links back to it. Use this instead of searching again when you have a specific note and want its neighbourhood.",
		inputSchema: {
			type: "object",
			properties: {
				note: { type: "string", description: "Note title, path or vault:// URI" },
			},
			required: ["note"],
		},
		annotations: { title: "Expand a note's graph neighbourhood", ...READ_ONLY },
	},
	{
		name: "recall",
		description:
			"Retrieve the durable lessons this repo is allowed to see, most specific first. Call this BEFORE making a decision you might already have made once — the vault is where the last session left its reasoning. Returns only memories scoped to reach you; another project's memories are withheld by design.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Optional filter. Omit to see everything in scope, which is usually what you want at the start of a task.",
				},
				limit: { type: "number", description: "Max memories to return (default 20)." },
				explain: {
					type: "boolean",
					description:
						"Also report what was withheld and why. Use when a memory you expected is missing — it will tell you whether it was scoped away or never existed.",
				},
			},
		},
		annotations: { title: "Recall durable lessons", ...READ_ONLY },
	},
	{
		name: "record_work",
		description:
			"Record work that happened in this repo into the vault, filed where it belongs. This is a durable record, not a scratch note — write it for a future session that will NOT have your context and cannot re-read your diff. Fill every field you can; sparse records are near-worthless six weeks later. Use dry_run to preview the filed note first.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short, specific. 'Add archive command' not 'update'." },
				summary: {
					type: "string",
					description:
						"2-4 sentences: what happened and why it was done. Enough for someone to decide whether to read on.",
				},
				changes: {
					type: "array",
					items: { type: "string" },
					description:
						"One line per file or component touched, saying what changed and why. e.g. 'src/store.mjs - added pure archive(db,id); marks a flag rather than removing, so seq is untouched'.",
				},
				decisions: {
					type: "array",
					items: { type: "string" },
					description:
						"Choices made and the reasoning, especially where you rejected an alternative. These are the entries most likely to matter later.",
				},
				learned: {
					type: "array",
					items: { type: "string" },
					description:
						"Surprises, gotchas, things that cost time or nearly went wrong. What you wish you had known starting out.",
				},
				verification: {
					type: "string",
					description:
						"How you know it works: tests run and their result, manual checks performed. State failures honestly.",
				},
				open: {
					type: "array",
					items: { type: "string" },
					description:
						"Unresolved threads, deferred work, known limits. Anything a reader should not assume is handled.",
				},
				informed_by: {
					type: "array",
					items: { type: "string" },
					description:
						"Vault notes you read that shaped this work, by title. Rendered as links, so those notes accumulate evidence they were actually used.",
				},
				folder: {
					type: "string",
					description:
						"Vault-relative destination, e.g. 'projects/pocket/notes'. Omit to file it under the calling repo's project automatically. Search the vault first if unsure where similar notes live.",
				},
				kind: {
					type: "string",
					enum: ["note", "decision"],
					description:
						"'decision' files it as a decision record with an undated title; 'note' is a dated point-in-time record. Default 'note'.",
				},
				dry_run: { type: "boolean", description: "Preview without writing (default false)" },
			},
			required: ["title", "summary"],
		},
		annotations: {
			title: "Record work into the vault",
			readOnlyHint: false,
			// Creates a new note; never edits or deletes an existing one.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
	},
	{
		name: "remember",
		description:
			"Record a DURABLE LESSON into the vault's memory — something that will still be true, and still useful, in a repo that is not this one. The test: would this help someone working on a different project? If yes, remember it. If it is a log of what you did here today, use record_work instead. Good memories: a constraint you discovered, a gotcha that cost you time, a rule that generalises. Bad memories: status updates, task summaries, anything you would not want to be told again in six weeks.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description:
						"The lesson itself, stated as a claim. 'tsup externals decide what a patch can fix', not 'patch notes'. This is what a future session will match against.",
				},
				body: {
					type: "string",
					description:
						"The lesson in full, written for someone with none of your context: what is true, why, and what it means for what they are about to do. State mechanisms, not narrative.",
				},
				confidence: {
					type: "string",
					enum: ["verified", "inferred", "unverified"],
					description:
						"'verified' = you checked it against the code, a doc, or a run. 'inferred' = you reasoned to it. 'unverified' = you were told or assumed it. Be honest; this is what a reader trusts.",
				},
				verification: {
					type: "string",
					description: "How you know. Required in spirit whenever confidence is 'verified'.",
				},
				scope: {
					type: "string",
					enum: ["general", "platform", "project"],
					description:
						"How far this reaches. 'project' = only projects you name. 'platform' = anything on the same platform. 'general' = everywhere, and it will be narrowed if you name projects. Reach for 'platform' before 'general': a dependency's quirk, a language's rule or a toolchain's behaviour is 'platform', however hard-won. 'general' means it would help someone whose stack shares nothing with yours.",
				},
				generality: {
					type: "string",
					description:
						"Why this reaches everywhere. Required in spirit whenever scope is 'general', the same way verification is for 'verified'.",
				},
				projects: {
					type: "array",
					items: { type: "string" },
					description:
						"Every project this applies to — a LIST, so a lesson spanning two projects reaches both. Omit for a platform or general lesson.",
				},
				platforms: {
					type: "array",
					items: { type: "string" },
					description: "Platforms this applies to, e.g. ['ios']. Used with scope 'platform'.",
				},
				links: {
					type: "array",
					items: { type: "string" },
					description:
						"Vault notes this relates to, by title. Unresolvable ones are dropped and reported rather than written as broken links.",
				},
				supersedes: {
					type: "array",
					items: { type: "string" },
					description:
						"Exact titles of memories this CORRECTS. They are kept and back-linked, not deleted, and this one will outrank them. Use when you have learned that something recorded earlier is wrong.",
				},
				force: {
					type: "boolean",
					description:
						"Write even if a near-identical memory already exists. Default false — you will be told what it collided with.",
				},
				dry_run: { type: "boolean", description: "Preview without writing (default false)." },
			},
			required: ["title", "body", "confidence"],
		},
		annotations: {
			title: "Remember a durable lesson",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
	},
	{
		name: "reason",
		description:
			"Ask the vault a question that needs JUDGEMENT ACROSS several notes rather than retrieval of one — 'is what I am about to do consistent with what we decided', or 'these notes disagree, what did we actually conclude'. It reads the vault with a second Claude session, so it takes longer and uses more than the other tools: reach for it when search or recall returned the notes but not the answer, and use those instead when they would do. It seeds itself from search, so you do not need to search first.",
		inputSchema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description:
						"The judgement you need, stated in full. It is answered by a session that cannot see this conversation, so include what you are about to do and why it matters — a bare topic gets a summary rather than a verdict.",
				},
			},
			required: ["question"],
		},
		annotations: {
			title: "Reason over the vault (spawns a second session)",
			readOnlyHint: true,
			destructiveHint: false,
			// Same question, different answer, different usage.
			idempotentHint: false,
			// It starts a process that reads the vault and calls a model.
			openWorldHint: true,
		},
	},
	{
		name: "health",
		description:
			"Check that this vault's wiring is intact: where memories actually live, which roots are exposed, whether the search index is reachable, and whether any memories reference a project that no longer resolves. Call this when something that should be in the vault cannot be found — every failure in this layer presents identically as 'no results', and this is what tells them apart.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Check vault wiring", ...READ_ONLY },
	},
];

