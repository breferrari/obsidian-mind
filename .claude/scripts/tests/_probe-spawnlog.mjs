import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const t0 = performance.now();
const log = (kind, cmd, args, ms) => process.stderr.write(`[spawn] ${kind} ${ms.toFixed(0)}ms ${String(cmd).slice(0, 60)} ${(args || []).slice(0, 4).join(" ").slice(0, 80)}\n`);
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
	const orig = cp[name];
	cp[name] = function (cmd, args, ...rest) {
		const s = performance.now();
		try { return orig.call(this, cmd, args, ...rest); } finally { log(name, cmd, Array.isArray(args) ? args : [], performance.now() - s); }
	};
}
for (const name of ["spawn", "execFile", "exec"]) {
	const orig = cp[name];
	cp[name] = function (cmd, args, ...rest) {
		const s = performance.now();
		const child = orig.call(this, cmd, args, ...rest);
		child.on?.("exit", () => log(name + "(async)", cmd, Array.isArray(args) ? args : [], performance.now() - s));
		return child;
	};
}
syncBuiltinESMExports();
process.on("exit", () => process.stderr.write(`[total] ${(performance.now() - t0).toFixed(0)}ms after preload\n`));
