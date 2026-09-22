/**
 * Minimal, dependency-free glob matcher for `readyset.review.sensitivePaths` and any future
 * path-pattern config. Supports the subset those defaults need — nothing more:
 *   - `*`  matches any run of characters EXCEPT `/`
 *   - `**` matches any run of characters INCLUDING `/` (a `**\/` — at any position, not just the
 *          start — also matches zero directories, so `**\/auth/**` matches `auth/x.ts` and
 *          `src/auth/x.ts`, and `src/**\/auth.ts` matches `src/auth.ts`)
 *   - `?`  matches exactly one character except `/`
 *   - everything else is literal
 * Patterns and paths are matched as POSIX-style, repo-relative strings (forward slashes).
 * Matching is case-insensitive.
 *
 * Hand-rolled on purpose: this package has zero runtime dependencies, so there is no
 * minimatch/picomatch to lean on (see `configure.mjs`'s note on that policy). The subset above
 * is small enough that a char-by-char translation to a RegExp is all that's needed.
 */

/** Escapes the single regex-special character `ch` so a literal pattern char matches itself. */
function escapeRegExpChar(ch: string): string {
	return ".+^${}()|[]\\".includes(ch) ? `\\${ch}` : ch;
}

/** Translates a glob pattern into an anchored RegExp. The pattern-language subset is documented
 *  on this module. An empty pattern yields `^$`, which matches only an empty path. */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` matches zero or more directories, at ANY position (so `src/**/auth.ts`
				// matches `src/auth.ts`, and a leading `**/auth/**` matches `auth/x.ts`); any other
				// `**` spans path separators too.
				if (pattern[i + 2] === "/") {
					source += "(?:.*/)?";
					i += 2;
					continue;
				}
				source += ".*";
				i += 1;
				continue;
			}
			source += "[^/]*";
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExpChar(ch);
	}
	return new RegExp(`^${source}$`, "i");
}

/** Normalizes a repo-relative path for matching: `\` → `/`, strip a leading `./`. */
export function normalizeGlobPath(path: string): string {
	const slashed = path.replace(/\\/g, "/");
	return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}

/** True when `path` (repo-relative, `/`-separated) matches `pattern`. */
export function matchGlob(path: string, pattern: string): boolean {
	return globToRegExp(pattern).test(normalizeGlobPath(path));
}

/** True when `path` matches ANY pattern in `patterns` (empty list → false). */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
	const normalized = normalizeGlobPath(path);
	for (const pattern of patterns) {
		if (globToRegExp(pattern).test(normalized)) return true;
	}
	return false;
}
