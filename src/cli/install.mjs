#!/usr/bin/env node
/**
 * Readyset's install CLI.
 *
 * Usage (from the root of the repo you want Readyset in):
 *   npx readyset-review install
 *   npx readyset-review install --target /path/to/repo   (defaults to cwd)
 *
 * Deliberately NOT wired to npm's `postinstall` lifecycle. postinstall runs with cwd set to
 * this package's own directory inside node_modules, not the consuming repo's root — using it
 * would mean either guessing at the consumer's root or writing outside node_modules during an
 * install nobody explicitly asked for. An explicit `readyset-review install` command (the same pattern
 * tools like husky use) is predictable: it only touches files when you run it, and it always
 * targets the directory you ran it from.
 *
 * What it does: copies the .ts source files straight into .omp/lib/ and .omp/extensions/ in the
 * target repo, and the skill doc into .agent/skills/. No build step — omp loads extensions as
 * .ts files directly (its own loader handles the stripping), so there is nothing to compile.
 * Every run overwrites the previously installed copies; this is how you pick up a Readyset
 * update (bump the package, re-run `readyset-review install`). Don't hand-edit the installed
 * files — edits are lost on the next install.
 *
 * These destinations are omp's own documented project-level discovery paths (verified against
 * omp's `docs/extension-loading.md` and `docs/skills.md`, not guessed): extensions are
 * auto-discovered from `<cwd>/.omp/extensions` ("Native auto-discovery comes from: Project
 * directory: `<cwd>/.omp/extensions`" — the project root is scanned non-recursively, cwd only,
 * no ancestor-directory search), and skills from the "agents" provider's canonical project
 * location `.agent[s]/skills/<name>/SKILL.md` (both `.agent/` and `.agents/` are accepted; this
 * installer uses `.agent/`). An earlier version of this installer used `agent/lib/`,
 * `agent/extensions/`, `agent/skills/` (no leading dot) — that was an unverified guess and omp
 * never actually discovered anything installed there. If you installed with that older version,
 * re-run install and delete the stale `agent/` directory it left behind.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, copyFile, readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");

const INSTALL_MAP = [
	{ from: join(packageRoot, "src", "lib", "brainstorm.ts"), to: join(".omp", "lib", "brainstorm.ts") },
	{ from: join(packageRoot, "src", "lib", "readyset-spec.ts"), to: join(".omp", "lib", "readyset-spec.ts") },
	{ from: join(packageRoot, "src", "lib", "omp-config.ts"), to: join(".omp", "lib", "omp-config.ts") },
	{ from: join(packageRoot, "src", "extensions", "readyset-review.ts"), to: join(".omp", "extensions", "readyset-review.ts") },
	// Reference doc, not a runtime file — read by an agent working a Readyset change directly
	// (outside a /readyset-review-triggered turn), not loaded by the extension itself. Installed
	// under .agent/skills/<name>/SKILL.md — omp's documented canonical project-level skill
	// location (the "agents" provider), confirmed against docs/skills.md.
	{ from: join(packageRoot, "src", "skill", "SKILL.md"), to: join(".agent", "skills", "readyset", "SKILL.md") },
];

function parseArgs(argv) {
	const args = { command: argv[0], target: process.cwd() };
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "--target" && argv[i + 1]) {
			args.target = argv[i + 1];
			i++;
		}
	}
	return args;
}

async function install(targetRoot) {
	let installedCount = 0;
	for (const { from, to } of INSTALL_MAP) {
		const dest = join(targetRoot, to);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(from, dest);
		console.log(`  installed: ${to}`);
		installedCount++;
	}
	console.log(`\nReadyset: ${installedCount} file(s) installed into ${targetRoot}`);
	console.log("Run `/readyset-review` in omp inside this repo to use it.");
	console.log("Re-run `npx readyset-review install` after bumping the readyset-review version to pick up updates.");
}

async function printVersion() {
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	console.log(pkg.version);
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

	console.log("Readyset CLI\n");
	console.log("Usage:");
	console.log("  readyset-review install [--target <path>]   Install/update Readyset's extension files into a repo (defaults to cwd)");
	console.log("  readyset-review version                     Print the installed Readyset package version");
	process.exitCode = args.command ? 1 : 0;
}

main().catch((err) => {
	console.error("Readyset install failed:", err?.message ?? err);
	process.exitCode = 1;
});
