/**
 * A tiny, separate entry point for `readyset-review validate` — invoked as a child process by
 * `install.mjs` with `--experimental-strip-types`, never imported directly.
 *
 * `install.mjs` itself is careful to stay plain `.mjs` with no TypeScript imports, on purpose:
 * `readyset-review install`/`version` only need to exist on whatever Node the user has
 * (`package.json`'s `engines` says `>=18`), and importing a `.ts` file from plain `.mjs` needs
 * `--experimental-strip-types` (Node 22.6+) or a build step this package deliberately has
 * neither of. `validate` is the one CLI command that genuinely needs to run `readyset-spec.ts`'s
 * real `validateChange` logic — not a re-implementation of it, which would drift from what the
 * omp gate itself actually checks — so it's split into this separate file and run as a
 * subprocess specifically spawned with the flag (see `runValidate` in `install.mjs`), rather
 * than requiring the modern-Node-only flag for the whole CLI.
 *
 * Contract with `install.mjs`: argv is `[cwd, changeId]`; stdout is exactly one line of JSON
 * (a `ValidateResult`); exit code is 0 when `ok`, 1 otherwise, 2 on an unexpected crash (so
 * `install.mjs` can tell "validation ran and failed" apart from "the runner itself broke").
 */

import { validateChange } from "../lib/readyset-spec.ts";

async function main() {
	const [cwd, changeId] = process.argv.slice(2);
	if (!cwd || !changeId) {
		console.error("validate-runner.mts: expected argv [cwd, changeId]");
		process.exit(2);
	}
	const result = await validateChange(cwd, changeId);
	console.log(JSON.stringify(result));
	process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
	console.error(`validate-runner.mts crashed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
});
