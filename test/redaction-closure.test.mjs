/**
 * The redaction surface must stay CLOSED — one copy of the rules, and every
 * route error goes through the shared collector.
 *
 * ## Why this file exists
 *
 * `src/host/util.ts` owns the rules (`redactSecrets`) and
 * `src/host/routes/http.ts` owns the collector (`redactedError`). The
 * 2026-10-21 review found the two halves of that arrangement had drifted
 * apart in ways nothing was watching:
 *
 *   · the rule set had no shape for a BARE JWT — an access token with no key
 *     name in front of it (`request rejected, token eyJhbGciOi…`) — even
 *     though this plugin's access token IS a JWT;
 *   · the collector existed, but a route module could always hand-roll its own
 *     copy of the expression instead, and a hand-rolled copy is
 *     behaviourally IDENTICAL to the collector.
 *
 * Both are fixed. THIS file is what keeps them fixed.
 *
 * ## Why every check here is a SHAPE check
 *
 * A hand-rolled redaction copy produces byte-identical output to the shared
 * collector — that is precisely why it is dangerous and precisely why a
 * behaviour test cannot see it. The review could not tell the two apart from
 * the outside either. So the fences below look at the CODE, not at the output:
 * the only thing a test can assert about "there is exactly one copy of this
 * rule" is that the other copy is not there.
 *
 * Comments are stripped before every grep: the fix's own prose names these
 * expressions, and a fence that a comment can satisfy guards nothing.
 *
 * Peer-free: reads `src/host/routes/` as text and imports only `util.ts`
 * (a leaf with no Host peers), so it still runs on a clean checkout.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish } from "./harness.mjs";
import { redactSecrets } from "../src/host/util.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = join(ROOT, "src", "host", "routes");

/**
 * Blank every comment body, keeping the code and the string literals.
 * @param {string} src - the file text.
 * @returns {string} the text without comments.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i === 0) return ""; // a whole-line comment carries no code
      // An inline `//` that is not part of a `https://` URL starts a comment.
      return i > 0 && line[i - 1] !== ":" ? line.slice(0, i) : line;
    })
    .join("\n");
}

const routeFiles = readdirSync(ROUTES).filter((name) => name.endsWith(".ts")).sort();
const masked = new Map(routeFiles.map((name) => [name, stripComments(readFileSync(join(ROUTES, name), "utf8"))]));

// --- 1. the rule set still covers a bare JWT --------------------------------
// A dropped rule changes no output of any other test, so without this the
// 2026-10-21 fix would be silently reversible.
const bareJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU";
check("a bare JWT is redacted even with no key name in front of it",
  redactSecrets(`request rejected, token ${bareJwt}`) === "request rejected, token [REDACTED]",
  redactSecrets(`request rejected, token ${bareJwt}`));
check("a named credential is still redacted",
  redactSecrets('{"access_token":"abc123def456"}').includes("[REDACTED]"),
  redactSecrets('{"access_token":"abc123def456"}'));
check("ordinary prose is not mangled by the rules",
  redactSecrets("the token is expired") === "the token is expired",
  redactSecrets("the token is expired"));

// --- 2. every route module that catches a value goes through the collector -
// A `catch {` without a binding answers with a FIXED wording — there is no
// error text to redact. A catch that BINDS the error is the one that can
// carry a credential into the panel, so that is the one the fence is about.
const withoutCollector = [];
for (const name of routeFiles) {
  const code = masked.get(name) ?? "";
  if (!/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code)) continue;
  if (!code.includes("redactedError(")) withoutCollector.push(name);
}
check("every route module that catches a value goes through the shared collector",
  withoutCollector.length === 0,
  withoutCollector.length === 0
    ? `${routeFiles.length} route module(s) checked`
    : `${withoutCollector.join(", ")} catches a value without redactedError(`);

// --- 3. no route module hand-rolls its own redaction ------------------------
const handRolled = [];
for (const [name, code] of masked) {
  if (/redactSecrets\(\s*(error|err|why|e)\b/.test(code)) handRolled.push(name);
}
check("no route module hand-rolls its own redaction",
  handRolled.length === 0,
  handRolled.length === 0
    ? "the shared collector is the only copy"
    : `${handRolled.join(", ")} builds the message by hand`);

// --- 4. the collector exists, and it is the one that redacts ----------------
const http = masked.get("http.ts") ?? "";
check("the collector is exported from the route family's own module",
  /export function redactedError\(/.test(http),
  "src/host/routes/http.ts must export redactedError");
check("the collector redacts before it answers",
  /redactSecrets\(/.test(http),
  "src/host/routes/http.ts must run the message through redactSecrets");

finish({ noun: "redaction-closure checks" });
