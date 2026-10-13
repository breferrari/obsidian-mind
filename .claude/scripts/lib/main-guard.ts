/**
 * Detect whether the current ESM module was invoked directly as a script
 * (rather than imported). Use to gate side-effecting `main()` calls so the
 * module stays importable from tests and other modules.
 *
 *     if (isMainModule(import.meta.url)) main();
 *
 * Equivalent of CommonJS's `require.main === module`. `fileURLToPath` strips
 * the `file://` prefix and URL-encoded segments. Node gives the entry module
 * its real path, while `process.argv[1]` keeps the path as typed, so a
 * symlinked folder on the way (macOS's /var, a link to /private/var, or a
 * Windows junction) is resolved on the argv side too.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The real path, or the path itself when it can't be resolved. */
const real = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

export function isMainModule(importMetaUrl: string): boolean {
	const argv1 = process.argv[1];
	if (argv1 === undefined) return false;
	const modulePath = fileURLToPath(importMetaUrl);
	// The module's path is already real (the loader resolved it), so only
	// argv[1] needs resolving.
	return modulePath === argv1 || modulePath === real(argv1);
}
