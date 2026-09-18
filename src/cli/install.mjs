#!/usr/bin/env node
/**
 * Readyset's install CLI.
 *
 * Usage:
 *   npx readyset-review install
 *   npx readyset-review install --target /path/to/.omp   (defaults to ~/.omp)
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
 * `readyset-review install` command (the same pattern tools like husky use) is predictable: it
 * only touches files when you run it.
 *
 * What it does: copies the .ts source files into `<target>/agent/lib/` and
 * `<target>/agent/extensions/`, and the skill doc into `<target>/agent/skills/`. No build step —
 * omp loads extensions as .ts files directly (its own loader handles the stripping), so there is
 * nothing to compile. Every run overwrites the previously installed copies; this is how you pick
 * up a Readyset update (bump the package, re-run `readyset-review install`). Don't hand-edit the
 * installed files — edits are lost on the next install.
 *
 * These destinations are omp's own documented user-level discovery paths (verified against
 * omp's `docs/extension-loading.md` and `docs/skills.md`, and against a real `~/.omp` on a
 * machine already running other extensions — not guessed): "User-level (global): the active
 * agent directory's extensions/" resolves to `~/.omp/agent/extensions` by default, with a
 * matching `~/.omp/agent/lib/` convention already in use there for shared helpers, and
 * `~/.omp/agent/skills/<name>/SKILL.md` for skills.
 *
 * Every installed filename is prefixed `readyset-` (`readyset-brainstorm.ts`,
 * `readyset-omp-config.ts`, `readyset-spec.ts`, `readyset-review.ts`) — deliberately, because
 * `~/.omp/agent/` is a shared namespace: a real `~/.omp/agent/lib/brainstorm.ts` was found
 * already installed and in active use by other extensions (`brainstorm-plan.ts`,
 * `brainstorm-propose.ts`, `brainstorm-review.ts`) on the machine this was verified against.
 * An unprefixed `brainstorm.ts` from this package would have silently overwritten that file —
 * same name, similar shape, different content — and broken those other extensions the moment
 * this package was installed. Nothing this package installs can collide with another
 * extension's files as long as that extension doesn't also use the `readyset-` prefix.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, copyFile, readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");
const DEFAULT_TARGET = join(homedir(), ".omp");

const INSTALL_MAP = [
	{ from: join(packageRoot, "src", "lib", "readyset-brainstorm.ts"), to: join("agent", "lib", "readyset-brainstorm.ts") },
	{ from: join(packageRoot, "src", "lib", "readyset-spec.ts"), to: join("agent", "lib", "readyset-spec.ts") },
	{ from: join(packageRoot, "src", "lib", "readyset-omp-config.ts"), to: join("agent", "lib", "readyset-omp-config.ts") },
	{ from: join(packageRoot, "src", "lib", "readyset-review-overlay.ts"), to: join("agent", "lib", "readyset-review-overlay.ts") },
	{ from: join(packageRoot, "src", "extensions", "readyset-review.ts"), to: join("agent", "extensions", "readyset-review.ts") },
	// Reference doc, not a runtime file — read by an agent working a Readyset change directly
	// (outside a /readyset-review-triggered turn), not loaded by the extension itself. Installed
	// under agent/skills/<name>/SKILL.md, matching the real ~/.omp/agent/skills/<name>/SKILL.md
	// layout already in use on the machine this was verified against.
	{ from: join(packageRoot, "src", "skill", "SKILL.md"), to: join("agent", "skills", "readyset", "SKILL.md") },
];

function parseArgs(argv) {
	const args = { command: argv[0], target: DEFAULT_TARGET };
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
	console.log("Run `/readyset-review` in omp (in any repo) to use it.");
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
	console.log("  readyset-review install [--target <path>]   Install/update Readyset's extension files (defaults to ~/.omp)");
	console.log("  readyset-review version                     Print the installed Readyset package version");
	process.exitCode = args.command ? 1 : 0;
}

main().catch((err) => {
	console.error("Readyset install failed:", err?.message ?? err);
	process.exitCode = 1;
});
