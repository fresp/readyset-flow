import { existsSync } from "node:fs";
import type { OutsideRepoKind } from "./readyset-types.ts";

/** The stay-in-repo tripwire's classifier. Pure; the per-run tally lives in ReadysetState. */
export const OUTSIDE_REPO_TOOLS = new Set(["bash", "read", "grep", "glob"]);

/** Memoized `existsSync('/<segment>')` — a top-level directory listing never changes mid-run. */
export const topLevelDirCache = new Map<string, boolean>();
export function isRealTopLevelDir(segment: string): boolean {
	const cached = topLevelDirCache.get(segment);
	if (cached !== undefined) return cached;
	let exists = false;
	try { exists = segment !== "" && existsSync(`/${segment}`); } catch { exists = false; }
	topLevelDirCache.set(segment, exists);
	return exists;
}

/** Classifies a tool call's arguments as reaching outside `cwd`; `undefined` when nothing does.
 *  - `~`/`$HOME` and a bare `/` (what `find /` reduces to) are always outside;
 *  - a leading redirection prefix (`>/x`, `2>/x`, `<`) is stripped before the test;
 *  - an absolute token counts only when its first segment is a real top-level directory on this
 *    host, so route strings like `/orders/:id` or `/products` drop out;
 *  - `/dev/*` is always ignored;
 *  - `/tmp/*` returns `"tmp"` (reported, not headline-counted). */
export function classifyOutsideRepoAccess(toolName: string, input: Record<string, unknown>, cwd: string): OutsideRepoKind | undefined {
	if (!OUTSIDE_REPO_TOOLS.has(toolName)) return undefined;
	const repoRoot = cwd.replace(/\/+$/, "");
	const texts: string[] = [];
	if (toolName === "bash") {
		if (typeof input.command === "string") texts.push(input.command);
		if (typeof input.cwd === "string" && input.cwd !== "") texts.push(input.cwd);
	} else if (toolName === "read" || toolName === "glob") {
		if (typeof input.path === "string") texts.push(input.path);
	} else if (toolName === "grep") {
		// Only `path` — `pattern` is a regex, never a path (`/orders/:id` is a route, not a dir).
		if (typeof input.path === "string") texts.push(input.path);
	}
	let sawTmp = false;
	for (const text of texts) {
		if (/\$HOME\b|\$\{HOME\}/.test(text)) return "outside";
		for (const raw of text.split(/[\s"'`;|&()]+/)) {
			const token = raw.replace(/^[0-9]*&?[<>]{1,2}/, ""); // strip a redirection prefix
			if (token === "") continue;
			if (token.startsWith("~")) return "outside";
			if (!token.startsWith("/")) continue;
			if (token === "/") return "outside";
			if (token === repoRoot || token.startsWith(`${repoRoot}/`)) continue;
			if (token === "/dev" || token.startsWith("/dev/")) continue;
			const segment = token.slice(1).split("/")[0];
			if (!isRealTopLevelDir(segment)) continue;
			if (segment === "tmp") { sawTmp = true; continue; }
			return "outside";
		}
	}
	return sawTmp ? "tmp" : undefined;
}
