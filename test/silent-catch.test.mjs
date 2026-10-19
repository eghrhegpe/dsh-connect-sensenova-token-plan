/**
 * Source hygiene — every statement-less `catch` must explain itself.
 *
 * `test/draw.test.mjs` §12 guards TWO hand-picked sites by grepping for their
 * literal `degrade("…")` markers. Its own comment records why that guard
 * exists: both paths end in "tool absent, panel fine", so the failure mode is
 * ABSENCE rather than a throw — and "a bare `catch {` on either path is a real
 * bug this repo has already shipped once". Two markers is a sample of that
 * class; this suite is the census over all of `src/`.
 *
 * The rule: a catch whose body holds no executable statement (empty, or a
 * comment and nothing else) must carry a comment. The comment is what separates
 * "deliberate best-effort swallow" from "nobody thought about it". All such
 * sites in `src/` already write one, so this gate is green on arrival — it
 * exists to catch the next `} catch {` written without the thought.
 *
 * Deliberately OUT of scope: `.catch(() => {})` PROMISE handlers (dozens of
 * sites, overwhelmingly best-effort `rm`/`deleteRecord` cleanup). Demanding
 * prose from all of those would be churn rather than coverage; the try/catch
 * form is the one this repo has actually been bitten by.
 *
 * Peer-free: reads `src/` as text and imports nothing from the Host, so it
 * still runs on a clean checkout.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/**
 * Blank every comment body AND every string body with spaces, preserving
 * offsets and newlines, and record where the comments were.
 *
 * String-awareness is not a nicety here: `src/` is full of URLs
 * (`"https://…"`) whose `//` would otherwise open a line comment and blank the
 * real code after it — including catches, which would then be invisible to a
 * gate whose whole job is to see every one of them.
 * @param {string} src - the file text.
 * @returns {{masked: string, comments: Array<[number, number]>}}
 */
function maskCommentsAndStrings(src) {
  const out = src.split("");
  const comments = [];
  let i = 0;
  let state = "code";
  let commentStart = -1;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (state === "code") {
      if (two === "//") { state = "line"; commentStart = i; out[i] = out[i + 1] = " "; i += 2; continue; }
      if (two === "/*") { state = "block"; commentStart = i; out[i] = out[i + 1] = " "; i += 2; continue; }
      if (c === '"' || c === "'") { state = c === '"' ? "dq" : "sq"; out[i] = " "; i++; continue; }
      if (c === "`") { state = "tpl"; out[i] = " "; i++; continue; }
      i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { comments.push([commentStart, i]); state = "code"; i++; continue; }
      out[i] = " "; i++; continue;
    }
    if (state === "block") {
      if (two === "*/") { comments.push([commentStart, i + 2]); out[i] = out[i + 1] = " "; state = "code"; i += 2; continue; }
      if (c !== "\n") out[i] = " ";
      i++; continue;
    }
    if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") { out[i] = " "; if (i + 1 < src.length && src[i + 1] !== "\n") out[i + 1] = " "; i += 2; continue; }
      if (c === quote) { out[i] = " "; state = "code"; i++; continue; }
      if (c !== "\n") out[i] = " ";
      i++; continue;
    }
    // state === "tpl": opaque on purpose. `${…}` interpolations are not
    // modelled — a `catch` inside one is not a thing that happens, and the
    // floors below turn any gross undercount that causes into a red rather
    // than into a quiet pass.
    if (c === "\\") { out[i] = " "; if (i + 1 < src.length) out[i + 1] = " "; i += 2; continue; }
    if (c === "`") { out[i] = " "; state = "code"; i++; continue; }
    if (c !== "\n") out[i] = " ";
    i++; continue;
  }
  if (state === "line" || state === "block") comments.push([commentStart, src.length]);
  return { masked: out.join(""), comments };
}

/** @param {string} text @param {number} off @returns {number} 1-based line */
const lineAt = (text, off) => text.slice(0, off).split("\n").length;

/**
 * Every real try/catch in one file, with the two facts the rule needs.
 * @param {string} raw - the file text.
 * @returns {Array<{line: number, hasStatement: boolean, hasComment: boolean}>}
 */
function analyzeFile(raw) {
  const { masked, comments } = maskCommentsAndStrings(raw);
  const found = [];
  for (const m of masked.matchAll(/\bcatch\b/g)) {
    const at = m.index;
    // `.catch(` is the promise-handler idiom, not a try/catch (see the header)
    if (/\.\s*$/.test(masked.slice(Math.max(0, at - 12), at))) continue;
    let i = at + "catch".length;
    const paren = masked.indexOf("(", i);
    const brace = masked.indexOf("{", i);
    if (brace === -1) continue;
    if (paren !== -1 && paren < brace) i = masked.indexOf(")", paren) + 1;
    const open = masked.indexOf("{", i);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let j = open; j < masked.length; j++) {
      if (masked[j] === "{") depth++;
      else if (masked[j] === "}") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close === -1) continue;
    found.push({
      line: lineAt(masked, at),
      hasStatement: masked.slice(open + 1, close).trim() !== "",
      hasComment: comments.some(([s, e]) => s > open && s < close)
    });
  }
  return found;
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(SRC);

let catches = 0;
let silent = 0;
const uncommented = [];
for (const file of files) {
  for (const c of analyzeFile(readFileSync(file, "utf8"))) {
    catches++;
    if (c.hasStatement) continue;
    silent++;
    if (!c.hasComment) {
      const rel = file.slice(ROOT.length + 1).split("\\").join("/");
      uncommented.push(`${rel}:${c.line}`);
    }
  }
}

// The floors come first and are not decoration: a masker that broke (say, a
// string form it does not model) would find FEWER catches, and "fewer catches"
// must never read as "more compliance". Two independent anchors — the scan
// reached the sources, and the scan found the catches — mirror this repo's own
// convention (panel.test.mjs's `sites >= 100`, components.length >= 20; the
// contract pin's shape floor).
check("the scan reached the TypeScript sources", files.length >= 80, `${files.length} file(s)`);
check("the scan found the try/catch blocks", catches >= 100, `${catches} catch block(s)`);
check("the scan found the statement-less catches it reasons about", silent >= 25, `${silent} statement-less`);
check("every statement-less catch explains itself",
  uncommented.length === 0,
  uncommented.length === 0 ? `${silent} statement-less of ${catches} scanned` : uncommented.join(", "));

finish({ noun: "source-hygiene checks" });
