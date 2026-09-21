/**
 * A tiny, separate entry point for `readyset-flow configure` — invoked as a child process by
 * `install.mjs` with `--experimental-strip-types`, never imported directly. Same reasoning as
 * `validate-runner.mts`: `install.mjs` stays plain `.mjs` with no TypeScript imports, so
 * `install`/`version` keep working on whatever Node the user has (`engines`: `>=18`); anything
 * that needs `readyset-omp-config.ts`'s real `parseYamlSubset` runs here instead, spawned with
 * `--experimental-strip-types` (Node 22.6+) — the same trade-off `validate` already made, not a
 * new one.
 *
 * This runner only ever *reads* the current config — it reuses the exact same parser Readyset's
 * own runtime reads `~/.omp/agent/config.yml` with (`parseModelOverride`/`parseFallbackChain`/
 * `parseLanguageOverride`), so what the wizard shows as "current" can't drift from what
 * `/readyset` itself would actually resolve. Writing back is deliberately NOT done here — see
 * `configure.mjs`'s module doc comment for why the write path is a plain-text splice instead.
 *
 * Contract with `install.mjs`: argv is `[configPath]`; stdout is exactly one line of JSON
 * (`{ language, modelDefault, fallbackChain }`, every field `undefined`-if-unset coming through
 * as JSON `null`/absent); exit code 0 on success (including "file doesn't exist" — that's a
 * valid "nothing configured yet" state, not an error), 2 on an unexpected crash.
 */

import { readFile } from "node:fs/promises";
import { parseModelOverride, parseFallbackChain, parseLanguageOverride, parseCompactMinContextPercent } from "../lib/readyset-omp-config.ts";

async function main() {
	const [configPath] = process.argv.slice(2);
	if (!configPath) {
		console.error("configure-runner.mts: expected argv [configPath]");
		process.exit(2);
	}
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) {
		console.log(JSON.stringify({ language: undefined, modelDefault: undefined, fallbackChain: [], compactMinContextPercent: undefined }));
		process.exit(0);
	}
	console.log(
		JSON.stringify({
			language: parseLanguageOverride(raw),
			modelDefault: parseModelOverride(raw),
			fallbackChain: parseFallbackChain(raw),
			// Report the *resolved* threshold only when the key is actually present, so the
			// wizard can tell "unset" (omit the block) from "explicitly set" (keep it) — a bare
			// `.percent` would always read as the default 25 even for a config that never set it.
			compactMinContextPercent: (() => {
				const parsed = parseCompactMinContextPercent(raw);
				return parsed.present ? parsed.percent : undefined;
			})(),
		}),
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(`configure-runner.mts crashed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
});
