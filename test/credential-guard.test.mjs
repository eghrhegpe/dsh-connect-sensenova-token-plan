/**
 * The credential fence: no secret is read through `str()`.
 *
 * WHAT IT PINS. In every shipped Host file (`src/host/**\/*.ts`, recursively —
 * `routes/` and `token-store/` included), a call to `str()` whose FIRST
 * argument names a credential-bearing field is a red site. `str()` trims and
 * demands non-empty (util.ts); `verbatim()` is its companion for secrets and
 * reads exactly as given. The rule is semantic — "does this argument chain name
 * a credential" — not a list of spellings someone thought of.
 *
 * WHY NOT A SHAPE REGEX — IT IS WHAT THIS FILE REPLACES. This repo shipped one:
 * block F5c in test/panel.test.mjs (ad8863f), a ten-shape alternation over
 * `readdir` of src/host/*.ts and src/host/token-store/*.ts, added with the
 * comment "scan the whole credential face so a new one cannot slip in". It was
 * green for a year-long afternoon while EIGHT reads still went through `str()`,
 * because an enumeration only contains the shapes its author already knew and
 * the anchor only matches the syntax the author was looking at:
 *
 *   - the anchor was `=\s*str\(`, so every object-literal read — `refreshToken:
 *     str(body.refresh_token, "")`, `access_token: str(source.accessToken, "")`,
 *     `autoRecoverArmed: str(...)`, `hasRefreshToken: str(...)` — was invisible.
 *     Four reads, one character of anchor.
 *   - `routes/` was never `readdir`'d, so `tokenFingerprint(str(catalogToken,
 *     ""))` could not be seen at all.
 *   - `catalogToken`, `source.accessToken`, `payload.refreshToken` and
 *     `stored?.refreshToken` are not in the alternation.
 *   - one of the remaining reads sat inside a template literal (`Bearer
 *     ${str(source.access_token ?? source.accessToken, "")}`), where the
 *     character before `str(` is `{`.
 *
 * A fence that reports green is worse than no fence: it teaches the next reader
 * that this surface is covered. The sibling plugin (agnes, 06337ce) reached the
 * same conclusion and this file is the same rule, ported.
 *
 * WHY THE FENCE READS THE REDACTION VOCABULARY. `SECRET_KEY` in src/host/util.ts
 * is already the one list of names that carry a credential, and it is exported
 * for this file. A name added for redaction therefore widens this fence in the
 * same commit — there is no second list to drift. (This repo's rules 5/6/7 had
 * already drifted apart as three hand-copied literals; they now read the same
 * constant.) The one addition is `credential` itself: redaction must not eat the
 * word out of prose ("invalid credential" is a login diagnosis), but a field of
 * that name holds a secret.
 *
 * WHY THE MATCH IS A SUFFIX. Credentials in the wild are `token`, `accessToken`,
 * `access_token`, `catalogToken`, `clientSecret`, `codeVerifier`, `apiKey` — the
 * credential word is the tail of the name, and the prefix is context (`source`,
 * `payload`, `stored`). Matching on the tail keeps the near-misses green:
 * `PASSWORD_REF` is an env-var *reference* (`passwordref`), `credentials` is the
 * container a username comes out of, `office_identity` / `nickname` / `scope` /
 * `message` are not secrets. A guard that reds those would be turned off within
 * a week.
 *
 * WHY THERE IS NO PROBE EXCEPTION. `str(stored?.refreshToken, "") !== ""` only
 * leaks a boolean, so it looks harmless. But it teaches the shape: the next
 * reader copies it one line up, where the value does travel. The blankness test
 * needs no `str()` at all — `verbatim(x, "").trim() !== ""` judges its own copy
 * and never rewrites the credential (util.ts's `verbatim` doc names that split).
 *
 * WHY IT CAN SKIP, AND WHY THAT IS NOT A HOLE. The scan is AST-level, so it
 * needs the TypeScript compiler the repo already builds with. CI installs
 * devDependencies before it runs any roster suite, so on every CI run this fence
 * runs; the only skippable environment is a checkout that never ran
 * `npm install`, where no build, no tsc and no render suite run either. The
 * floors below make "scanned nothing, found nothing" a failure rather than a
 * pass, so the skip can only be an environment fact, never a quiet green.
 *
 * @module test/credential-guard
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { results, check, fail, finish } from "./harness.mjs";
import { SECRET_KEY } from "../src/host/util.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(root, "src", "host");

/**
 * Normalize one credential word: `access[_-]?token` → `accesstoken`, so the
 * same comparison works for `access_token`, `access-token` and `accessToken`.
 * @param {string} word
 * @returns {string}
 */
function normalizeWord(word) {
  return word.replace(/\[_-\]\?/g, "").replace(/[_-]/g, "").toLowerCase();
}

// The vocabulary, derived from the redaction list rather than hand-copied.
const VOCABULARY = [
  ...new Set(SECRET_KEY.split("|").map(normalizeWord).filter((w) => w !== "")),
  "credential"
];

/**
 * Is this identifier / property name a credential-bearing field?
 * @param {string} name
 * @returns {boolean}
 */
function isCredentialName(name) {
  const normalized = name.replace(/[_-]/g, "").toLowerCase();
  return VOCABULARY.some((word) => normalized.endsWith(word));
}

/**
 * Every name a first-argument expression reads through: identifiers, property
 * names, and string/element-access keys. Recurses through calls, ternaries,
 * `??`, `as`, parentheses and template substitutions, so the chain is covered
 * no matter how it is spelled.
 * @param {import("typescript").Node | undefined} node
 * @param {string[]} out
 */
function namesInChain(node, out) {
  if (node === undefined) return;
  if (ts.isIdentifier(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    namesInChain(node.expression, out);
    out.push(node.name.text);
    return;
  }
  if (ts.isElementAccessExpression(node)) {
    namesInChain(node.expression, out);
    namesInChain(node.argumentExpression, out);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
    return;
  }
  ts.forEachChild(node, (child) => namesInChain(child, out));
}

/** Does this file import `str` from a util module? (A local helper named `str` is not ours.) */
function importsStrFromUtil(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !/(^|\/)util(\.ts)?$/.test(specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "str") return true;
    }
  }
  return false;
}

/**
 * Scan one source text. Returns `{ calls, offenders }` where each offender is
 * `{ line, argument }` — line 1-based, argument as written (whitespace folded).
 * @param {string} fileName - used only for position reporting.
 * @param {string} text
 * @returns {{calls: number, offenders: {line: number, argument: string}[]}}
 */
function scanSource(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!importsStrFromUtil(sourceFile)) return { calls: 0, offenders: [] };
  let calls = 0;
  const offenders = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "str" &&
      node.arguments.length > 0
    ) {
      calls += 1;
      const first = node.arguments[0];
      const names = [];
      namesInChain(first, names);
      if (names.some(isCredentialName)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        offenders.push({ line: line + 1, argument: first.getText(sourceFile).replace(/\s+/g, " ") });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, offenders };
}

/** Every `.ts` under `src/host`, recursively. */
function hostFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) hostFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

let ts;
try {
  ts = createRequire(import.meta.url)("typescript");
} catch {
  console.log("SKIP: the TS compiler is not installed — run `npm install`, then re-run.");
  console.log("       CI installs devDependencies before it runs this suite, so it never skips there.");
  process.exit(0);
}

// --- 1. the fence itself ----------------------------------------------------
// Order-of-magnitude tripwires, not targets: they exist so a walk that stops
// reaching the tree (wrong root, empty readdir, filter that drops everything)
// fails loudly instead of reporting "nothing to see".
const MIN_FILES = 30;
const MIN_STR_CALLS = 60;

{
  const files = hostFiles(hostDir);
  const offenders = [];
  let calls = 0;
  for (const file of files) {
    try {
      const scanned = scanSource(file, readFileSync(file, "utf8"));
      calls += scanned.calls;
      for (const offender of scanned.offenders) {
        offenders.push(`${relative(root, file).replace(/\\/g, "/")}:${offender.line} str(${offender.argument}, …)`);
      }
    } catch (error) {
      fail(`could not scan ${relative(root, file)}`, error);
    }
  }
  check(
    "every credential read goes through verbatim() — none through str()",
    offenders.length === 0,
    offenders.length ? `str() reads a credential in:\n  ${offenders.join("\n  ")}` : ""
  );
  check(`the walk reached the Host source (${files.length} files, floor ${MIN_FILES})`, files.length >= MIN_FILES);
  check(`the walk found the str() calls (${calls} call sites, floor ${MIN_STR_CALLS})`, calls >= MIN_STR_CALLS);
  // F5c scanned src/host/*.ts and src/host/token-store/*.ts — routes/ was the
  // blind spot that let one read through. Both subtrees must be in scope for
  // this fence to be worth anything.
  const relativeFiles = files.map((file) => relative(hostDir, file).replace(/\\/g, "/"));
  check("src/host/routes/ is in scope", relativeFiles.some((file) => file.startsWith("routes/")), relativeFiles.filter((f) => f.startsWith("routes/")).length);
  check("src/host/token-store/ is in scope", relativeFiles.some((file) => file.startsWith("token-store/")), relativeFiles.filter((f) => f.startsWith("token-store/")).length);
}

// --- 2. the vocabulary is the redaction list's, not a copy ------------------
{
  const words = SECRET_KEY.split("|").map(normalizeWord);
  check("the vocabulary came from util.ts's SECRET_KEY", words.length >= 5, words.join(","));
  check("`credential` is in the fence's vocabulary", VOCABULARY.includes("credential"));
  // `access[_-]?token` is one word spelled three ways on the wire; the
  // normalization must collapse them or a camelCase token sails past a
  // snake_case rule.
  check(
    "separator spellings collapse to one word",
    new Set(["access_token", "access-token", "accessToken"].map(normalizeWord)).size === 1 &&
      normalizeWord("access[_-]?token") === "accesstoken",
    ["access_token", "access-token", "accessToken", "access[_-]?token"].map(normalizeWord).join(",")
  );
  check(
    "the words the platform actually spells are covered",
    ["accesstoken", "refreshtoken", "idtoken", "apikey", "clientsecret", "codeverifier", "password", "secret", "token"].every((word) => VOCABULARY.includes(word)),
    VOCABULARY.join(",")
  );
}

// --- 3. the detector can actually detect (a fence that always passes is no fence)
// Every `mustRed` shape below was a REAL read in this repo (all eight were
// green under F5c); every `mustStayGreen` shape is a real, current site this
// fence must leave alone.
{
  const mustRed = [
    "str(source.access_token ?? source.accessToken, \"\")",
    "str(source.accessToken, \"\")",
    "str(source.refreshToken, \"\")",
    "str(body.refresh_token, \"\")",
    "str(payload.refreshToken, \"\")",
    "str(catalogToken, \"\")",
    "str(stored?.refreshToken, \"\") !== \"\"",
    "str(token, \"\")",
    "str(obj(obj(body).data).access_token, \"\")",
    "str(obj(credential).accessToken, \"\")",
    "str(credential?.accessToken, \"\")",
    "str(env.API_KEY, \"\")",
    "str(clientSecret, \"\")",
    "str(map[\"access_token\"], \"\")"
  ];
  const source = `import { str, obj } from "../util.ts";\n${mustRed
    .map((call, index) => `const v${index} = ${call};`)
    .join("\n")}\n`;
  const { calls, offenders } = scanSource("fixture-red.ts", source);
  check("every historical credential shape is red", offenders.length === mustRed.length, `${offenders.length}/${mustRed.length} caught`);
  check("the fixture's calls were actually visited", calls === mustRed.length, String(calls));

  const mustStayGreen = [
    "str(credentials?.username, \"\")",
    "str(env[PASSWORD_REF], \"\")",
    "str(source.office_identity ?? source.officeIdentity, \"\")",
    "str(source.nickname, \"\")",
    "str(source.bffBase, \"\")",
    "str(body.scope, cfg.scope)",
    "str(body.message, \"\")",
    "str(payload.code, \"\")",
    // Only the FIRST argument is the read; this must not be flagged for the
    // literal in the fallback position.
    "str(body.error_description, str(body.error, \"no access token requested\"))"
  ];
  const greenSource = `import { str, obj } from "../util.ts";\n${mustStayGreen
    .map((call, index) => `const g${index} = ${call};`)
    .join("\n")}\n`;
  const green = scanSource("fixture-green.ts", greenSource);
  check(
    "a username, an env reference, an identity, a scope and other non-secrets stay green",
    green.offenders.length === 0,
    green.offenders.map((o) => `${o.line}: ${o.argument}`).join("; ")
  );

  // A local helper that happens to be named `str` is not util's `str`, and
  // flagging it would make the fence a nuisance rather than a rule.
  const localSource = 'function str(value) { return String(value); }\nconst a = str(credential.accessToken);\n';
  const local = scanSource("fixture-local.ts", localSource);
  check("a `str` that is not imported from util.ts is not ours", local.offenders.length === 0, JSON.stringify(local.offenders));
}

finish();
