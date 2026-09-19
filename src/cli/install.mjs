#!/usr/bin/env node
/**
 * Readyset's install CLI.
 *
 * Usage:
 *   npx readyset-flow install
 *   npx readyset-flow install --target /path/to/.omp   (defaults to ~/.omp)
 *   npx readyset-flow configure   (interactive wizard for readyset: in ~/.omp/agent/config.yml
 *                                  -- see configure.mjs's own module doc comment; a separate
 *                                  command on purpose, so `install` itself stays non-interactive)
 *
 * Readyset installs GLOBALLY, into the user's own omp home directory (`~/.omp`), not into a
 * per-project repo. It's a personal workflow extension — like the other extensions already
 * living in `~/.omp/agent/extensions/` — meant to be available in every repo you work in, not
 * scoped to one. `--target` exists for testing against a scratch directory, not for per-repo
 * installs; if you actually want a project-scoped install, point `--target` at
 * `<repo>/.omp` yourself (omp does support that layout too — see docs/extension-loading.md —
 * this installer just doesn't default to it).
 *
 * Deliberately NOT wired to npm's `postinstall` lifecycle. postinstall runs with cwd set to
 * this package's own directory inside node_modules, not `~/.omp` — using it would mean an
 * install nobody explicitly asked for, writing outside node_modules. An explicit
 * `readyset-flow install` command (the same pattern tools like husky use) is predictable: it
 * only touches files when you run it.
 *
 * What it does: REFERENCES this package's own `.ts` source in place -- it does not copy it.
 * omp supports this directly: `<configDir>/settings.json`'s top-level `"extensions"` array
 * accepts an arbitrary file path, and if that path is a *file* (not a directory), omp loads it
 * as a full extension module exactly where it sits -- no requirement that it live under
 * `<configDir>/extensions/` first. This is real, source-verified behavior (omp's own
 * `loadExtensionModules`, in its native `.omp` discovery provider), not a guess or a convention
 * this package invented. So installing means: merge one absolute path --
 * `<packageRoot>/src/extensions/readyset-review.ts` -- into `<target>/agent/settings.json`'s
 * `extensions` array. `readyset-review.ts`'s own relative imports (`../lib/readyset-*.ts`)
 * resolve against *its actual location on disk*, not against where omp discovered it from --
 * that's ordinary Node module resolution, unaffected by how omp found the entry file. So every
 * other `.ts` file in this package (`src/lib/**`) needs no install step at all: it's read
 * straight out of wherever this package itself lives (a git clone, or `node_modules/readyset-
 * flow/` after `npm install`), and picking up an update is just updating the package -- no
 * re-run needed, since nothing was copied to go stale.
 *
 * The one thing this still copies is `src/skill/SKILL.md` -- a reference doc, not a runtime
 * file (see its own installed-path comment below): skills have no settings.json-array
 * equivalent in omp's native provider (only a fixed `~/.omp/agent/skills/` directory scan), so
 * referencing it in place isn't an option the way it is for the extension module. Being a
 * doc with no import graph of its own, a stale copy after an update is a much smaller problem
 * than a stale copy of runtime code would have been -- and `install` still re-copies it every
 * run, so `readyset-flow install` after a version bump keeps it current either way.
 *
 * Earlier versions of this installer copied every `.ts` file into `<target>/agent/lib/` and
 * `<target>/agent/extensions/`. That meant re-running `install` after every code change just to
 * pick it up, and it meant dropping files into a shared, globally-namespaced directory
 * (`~/.omp/agent/`) that other extensions also write into -- both of which this reference-based
 * approach avoids. If you have files from that older install still sitting in
 * `~/.omp/agent/lib/readyset-*.ts` / `~/.omp/agent/extensions/readyset-review.ts`, they're
 * inert leftovers once `settings.json` points at the package directly (a later `extensions`
 * entry always wins on a name collision in omp's own dedup) -- safe to delete by hand, `install`
 * won't do it for you.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { runConfigureWizard } from "./configure.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");
const DEFAULT_TARGET = join(homedir(), ".omp");
// Deliberately NOT derived from `--target`: readyset-omp-config.ts's OMP_CONFIG_PATH (what
// /readyset actually reads at runtime, via readPinnedModel/readFallbackChain/readPreferredLanguage)
// is always ~/.omp/agent/config.yml, regardless of where --target pointed the extension link
// itself -- those functions are called with no argument from readyset-review.ts, so they never
// see --target either. Writing the wizard's output anywhere else would produce a file /readyset
// never reads. Kept as a separate constant (not imported from the .ts file) so install.mjs stays
// import-free of .ts modules -- see the module doc comment above.
const OMP_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");

// The one file this package's own extension module is: what settings.json's `extensions` array
// gets pointed at. Exported so a test can exercise `linkExtension` against a scratch settings.json
// without going through the whole CLI.
export const EXTENSION_ENTRY_POINT = join(packageRoot, "src", "extensions", "readyset-review.ts");
const EXTENSION_ENTRY_BASENAME = basename(EXTENSION_ENTRY_POINT); // "readyset-review.ts"

const SKILL_DOC = { from: join(packageRoot, "src", "skill", "SKILL.md"), to: join("agent", "skills", "readyset", "SKILL.md") };

/**
 * Merge `EXTENSION_ENTRY_POINT` into `<agentDir>/settings.json`'s `extensions` array, replacing
 * any prior entry that resolves to a file also named `readyset-review.ts` (covers both a
 * previous run of this same installer, and the repo having moved since the last install) and
 * leaving every other entry -- anything belonging to another extension -- untouched.
 *
 * Returns "added" | "updated" | "unchanged" so the caller can report accurately.
 */
export async function linkExtension(agentDir) {
	const settingsPath = join(agentDir, "settings.json");
	let settings = {};
	let raw = null;
	try {
		raw = await readFile(settingsPath, "utf8");
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	if (raw !== null && raw.trim() !== "") {
		try {
			settings = JSON.parse(raw);
		} catch (err) {
			throw new Error(`${settingsPath} isn't valid JSON -- fix or remove it, then re-run install: ${err.message}`);
		}
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		throw new Error(`${settingsPath} isn't a JSON object at its top level -- can't add an "extensions" entry to it.`);
	}

	const existing = Array.isArray(settings.extensions) ? settings.extensions : [];
	const ours = existing.filter((entry) => typeof entry === "string" && basename(entry) === EXTENSION_ENTRY_BASENAME);
	const others = existing.filter((entry) => !(typeof entry === "string" && basename(entry) === EXTENSION_ENTRY_BASENAME));

	let status;
	if (ours.length === 1 && ours[0] === EXTENSION_ENTRY_POINT) {
		status = "unchanged";
	} else if (ours.length === 0) {
		status = "added";
	} else {
		status = "updated"; // stale path(s) pointing at a readyset-review.ts elsewhere -- replaced
	}

	if (status !== "unchanged") {
		settings.extensions = [...others, EXTENSION_ENTRY_POINT];
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	return { status, settingsPath };
}

async function install(targetRoot) {
	const agentDir = join(targetRoot, "agent");

	const dest = join(targetRoot, SKILL_DOC.to);
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(SKILL_DOC.from, dest);
	console.log(`  installed: ${SKILL_DOC.to}`);

	const { status, settingsPath } = await linkExtension(agentDir);
	const relSettingsPath = join(targetRoot === DEFAULT_TARGET ? "~/.omp" : targetRoot, "agent", "settings.json");
	if (status === "added") {
		console.log(`  linked:    ${EXTENSION_ENTRY_POINT}\n             -> added to ${relSettingsPath} ("extensions")`);
	} else if (status === "updated") {
		console.log(`  linked:    ${EXTENSION_ENTRY_POINT}\n             -> replaced a stale readyset-review.ts entry in ${relSettingsPath}`);
	} else {
		console.log(`  linked:    ${EXTENSION_ENTRY_POINT}\n             -> already up to date in ${relSettingsPath}`);
	}
	void settingsPath;

	console.log(`\nReadyset: installed into ${targetRoot} (extension referenced in place, not copied)`);
	console.log("Run `/readyset` in omp (in any repo) to use it.");
	console.log(
		"The extension module is read straight from this package, so code updates need no re-install -- " +
			"only re-run `readyset-flow install` after moving the package itself, or to refresh the skill doc.",
	);
}

async function printVersion() {
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	console.log(pkg.version);
}

function parseArgs(argv) {
	const args = { command: argv[0], target: DEFAULT_TARGET, cwd: process.cwd(), positional: [] };
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "--target" && argv[i + 1]) {
			args.target = argv[i + 1];
			i++;
		} else if (argv[i] === "--cwd" && argv[i + 1]) {
			args.cwd = argv[i + 1];
			i++;
		} else {
			args.positional.push(argv[i]);
		}
	}
	return args;
}

/**
 * `readyset-flow validate <change-id> [--cwd <path>]` — the same structural check the omp
 * gate runs before every "Approve & Execute"/Refine/Sidebar view, exposed here so it can run
 * outside an omp session (CI, a pre-commit hook, a plain terminal) without needing omp
 * installed at all. Runs `validate-runner.mts` (which does the real `validateChange` call) as
 * a subprocess with `--experimental-strip-types`, since `install.mjs` itself stays flag-free
 * (see the module doc comment and `validate-runner.mts`'s own for why).
 *
 * Exit code mirrors `validateChange`'s `ok`: 0 = pass, 1 = structural issues found -- so this
 * composes directly into a CI step (`readyset-flow validate my-change || exit 1`) or a
 * pre-commit hook without any extra parsing.
 */
async function validate(changeId, targetCwd) {
	if (!changeId) {
		console.error("Usage: readyset-flow validate <change-id> [--cwd <path>]");
		process.exitCode = 1;
		return;
	}
	const runner = join(packageRoot, "src", "cli", "validate-runner.mts");
	const result = spawnSync(process.execPath, ["--experimental-strip-types", runner, targetCwd, changeId], {
		encoding: "utf8",
	});

	if (result.error) {
		console.error(`Couldn't run the validator: ${result.error.message}`);
		console.error(
			"`readyset-flow validate` needs Node 22.6+ (it runs readyset-spec.ts's real check via " +
				"--experimental-strip-types, the same way this package's own test suite does) -- " +
				"`install`/`version` have no such requirement.",
		);
		process.exitCode = 1;
		return;
	}

	const stdout = result.stdout?.trim();
	if (!stdout || result.status === 2) {
		console.error(result.stderr?.trim() || "The validator crashed without output.");
		process.exitCode = 1;
		return;
	}

	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		console.error("The validator produced output that wasn't valid JSON:");
		console.error(stdout);
		if (result.stderr?.trim()) console.error(result.stderr.trim());
		process.exitCode = 1;
		return;
	}

	console.log(parsed.summary);
	for (const issue of parsed.issues) {
		console.log(`  - ${issue.file}: ${issue.problem}`);
	}
	process.exitCode = parsed.ok ? 0 : 1;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.command === "install") {
		await install(args.target);
		return;
	}
	if (args.command === "--version" || args.command === "-v" || args.command === "version") {
		await printVersion();
		return;
	}
	if (args.command === "validate") {
		await validate(args.positional[0], args.cwd);
		return;
	}
	if (args.command === "configure") {
		const runnerPath = join(packageRoot, "src", "cli", "configure-runner.mts");
		await runConfigureWizard(OMP_CONFIG_PATH, { spawnSync, runnerPath });
		return;
	}

	console.log("Readyset CLI\n");
	console.log("Usage:");
	console.log("  readyset-flow install [--target <path>]        Reference this package's extension in <target>/agent/settings.json");
	console.log("                                                    (defaults to ~/.omp) and refresh the installed skill doc");
	console.log("  readyset-flow configure                        Interactive wizard for the readyset: section of");
	console.log("                                                    ~/.omp/agent/config.yml (language, model, fallback chain) --");
	console.log("                                                    never runs on its own; only install/validate/version are");
	console.log("                                                    non-interactive and safe to script");
	console.log("  readyset-flow validate <change-id> [--cwd <path>]");
	console.log("                                                    Run the same structural check the omp gate runs, outside omp");
	console.log("                                                    (CI, pre-commit) -- exit code 0 on pass, 1 on issues found");
	console.log("  readyset-flow version                          Print the installed Readyset package version");
	process.exitCode = args.command ? 1 : 0;
}

// Guarded so this file can be `import()`ed (e.g. by test/readyset-install-link.test.mts, to call
// `linkExtension` directly) without actually running the CLI as a side effect of importing it.
// Still runs exactly as before when executed directly (`node install.mjs ...`, or spawned as a
// subprocess the way test/readyset-cli-validate.test.mts already does) -- import.meta.url only
// equals the invoked script's own path in that case.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error("Readyset install failed:", err?.message ?? err);
		process.exitCode = 1;
	});
}
