/**
 * Detect whether the current ESM module was invoked directly as a script
 * (rather than imported). Use to gate side-effecting `main()` calls so the
 * module stays importable from tests and other modules.
 *
 *     if (isMainModule(import.meta.url)) main();
 *
 * Equivalent of CommonJS's `require.main === module`. `fileURLToPath` strips
 * the `file://` prefix and URL-encoded segments so the comparison against
 * `process.argv[1]` (which is already an absolute resolved path) is
 * apples-to-apples on every platform.
 */

import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl: string): boolean {
	return (
		process.argv[1] !== undefined &&
		fileURLToPath(importMetaUrl) === process.argv[1]
	);
}
