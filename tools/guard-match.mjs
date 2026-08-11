/**
 * How a guard pattern is matched against a source file. One implementation.
 *
 * `tools/verify-guards.mjs` and `test/verify-guards.test.ts` both ask "does this
 * pattern occur exactly `count` times?", and they had two copies of the answer.
 * The copies disagreed the moment line endings entered the picture: the tool was
 * taught about CRLF and the test was not, so the test failed with "pattern
 * matches 0 time(s)" while the tool it is testing reported every guard proven.
 *
 * WHY CRLF IS IN SCOPE AT ALL: patterns in tools/guards.mjs are written with
 * `\n`, and git's Windows default (`core.autocrlf=true`, which this repo does
 * not override with a .gitattributes) checks the working tree out as CRLF. Every
 * multi-line pattern then matches zero times, so on a stock Windows clone the
 * mechanism that proves each control load-bearing is itself inoperative — the
 * exact failure mode it exists to catch.
 *
 * Adapting the PATTERN, rather than normalising the FILE, keeps the check
 * read-only: rewriting the developer's tree as a side effect of a verification
 * run is how a "check" becomes a change.
 */

/** The pattern as it would appear in `source`, given that file's line endings. */
export function forSource(source, pattern) {
  return source.includes('\r\n') ? pattern.replace(/\n/g, '\r\n') : pattern;
}

/** How many times `pattern` occurs in `source`, line endings accounted for. */
export function countMatches(source, pattern) {
  return source.split(forSource(source, pattern)).length - 1;
}
