/**
 * The official Raccoon desktop client's login state, READ-ONLY
 * (ROADMAP §6.1.11 — the owner's 2026-11-17 reversal of §6.1.10's blanket
 * "不做" on importing it).
 *
 * What this is: the App writes `~/.box-agent/config/auth.json` for its local
 * agent, and the `access_token` in it is a gateway credential of the SAME
 * auth domain this plugin's second upstream already talks to
 * (`xiaohuanxiong.com`). Measured 2026-11-17 on a real install, read-only
 * requests only:
 *
 *   - `GET /api/web/llm/v2/model_catalog` → `200 {"code":0}` — the token works here;
 *   - `GET /api/web/points/v1/balance`    → `200`, the same points pool the panel
 *     already shows, so no second accounting universe appears;
 *   - sending the file's `office_identity` (the literal `"personal"`) as
 *     `X-Org-Code` → `400 {"code":200022,"message":"org_not_found_error"}`; sending
 *     an EMPTY `X-Org-Code` → `200`. That field is an identity LABEL, not an org
 *     code — which is why {@link raccoonDesktopCredentialFrom} hands back
 *     `officeIdentity: ""` and never forwards it.
 *
 * What this deliberately is NOT:
 *
 *   - **not a refresh client.** This module imports no fetcher, so it
 *     structurally cannot rotate anything. Today's App does not even put a
 *     `refresh_token` in the file (only `access_token` + `office_identity`; the
 *     refresh lives in the renderer's Electron storage, which is out of bounds).
 *     §6.1.10 rejected the read-import because refreshing would burn the App's
 *     single-use token — with no token to burn and no code path that could, that
 *     objection does not reach this module. The write-back route stays rejected:
 *     **nothing here writes a byte**.
 *   - **not a second credential store.** The App's file is the owner of record
 *     and stays the authority; this module is a VIEW of it. `raccoon-store.ts`
 *     decides precedence, and the desktop token never lands in
 *     `~/.dsh/.credentials.yaml`, in this plugin's directory, in git, or in a log
 *     (red line 1). The reason is duplication, not format: a copy here goes
 *     stale the moment the App rotates its file, and a stale copy of somebody
 *     else's login is worse than a re-read — which is also why no
 *     "import once, then it is ours" state exists.
 *
 * The window this buys: the App's access token is now a **30-day** JWT
 * (measured `iat` → `exp` = exactly 30 days; the archived
 * `upstream/dsh-raccoon-work-old0.16` contract recorded 3 hours, which is when
 * §6.1.10 sized the trade-off). "Read the file, never refresh" therefore covers
 * the durability that used to be the only argument for writing back.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-desktop-creds
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { obj, str } from "./util.ts";
import { decodeRaccoonJwtExpMs } from "./raccoon-http.ts";

/**
 * The App's own override for where its agent state lives (archived contract §1,
 * confirmed against the current install): `BOX_AGENT_CONFIG_DIR` replaces the
 * whole `<home>/.box-agent/config` directory, not just its tail.
 */
export const RACCOON_DESKTOP_DIR_ENV = "BOX_AGENT_CONFIG_DIR";

/** The file name inside that directory (fixed by the App's writer). */
export const RACCOON_DESKTOP_FILE = "auth.json";

/** The directory segment the App uses when the env override is absent. */
export const RACCOON_DESKTOP_HOME_DIR = ".box-agent";

/** Origin marker: the live credential came from the App's file. */
export const RACCOON_ORIGIN_DESKTOP = "desktop-file";

/** Origin marker: the live credential came from this plugin's own QR scan. */
export const RACCOON_ORIGIN_QR = "qr-scan";

/**
 * A ceiling on what we are willing to parse. The real file is ~490 bytes; the
 * limit exists so a symlink into a log archive, or a corrupted multi-megabyte
 * document, cannot turn a panel poll into a memory event.
 */
export const RACCOON_DESKTOP_MAX_BYTES = 64 * 1024;

/**
 * Refuse to hand out a token with less than this much life left. The consumer
 * issues a request AFTER reading the credential, so one that expires mid-flight
 * surfaces as a gateway 401 with no traceable cause; 60 seconds costs nothing
 * against a 30-day window.
 */
export const RACCOON_DESKTOP_LEAD_MS = 60_000;

/**
 * Why the desktop file is not a usable credential right now.
 *
 * Secret-free by construction: these strings reach the panel route and through
 * it the browser, so a reason carries a CATEGORY — never a path, a size, a
 * parse excerpt, or anything derived from the token.
 */
export const RACCOON_DESKTOP_REASON = Object.freeze({
  /** No such file: the App was never installed, or never logged in. */
  MISSING: "missing",
  /** Present but unreadable: permissions, or a rename in flight. */
  UNREADABLE: "unreadable",
  /** Larger than {@link RACCOON_DESKTOP_MAX_BYTES}. */
  TOO_LARGE: "too_large",
  /** Not a JSON object. */
  MALFORMED: "malformed",
  /** JSON parsed, but it carries no usable `access_token`. */
  NO_TOKEN: "no_token",
  /** The token is not a JWT with an `exp` this module can honour. */
  NO_EXPIRY: "no_expiry",
  /** Inside {@link RACCOON_DESKTOP_LEAD_MS} of (or past) its own expiry. */
  EXPIRED: "expired"
});

/** The union of {@link RACCOON_DESKTOP_REASON} values. */
export type RaccoonDesktopReasonValue = typeof RACCOON_DESKTOP_REASON[keyof typeof RACCOON_DESKTOP_REASON];

/** The one-entry stat-keyed cache behind {@link readRaccoonDesktopCredential}. */
let cache: { key: string; value: any } | null = null;

/**
 * Where this build looks for the App's credential file.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - defaults to `process.env`.
 * @param {string} [options.home] - defaults to `os.homedir()`.
 * @returns {string} the absolute `auth.json` path.
 */
export function raccoonDesktopAuthPath({ env = process.env, home = homedir() }: { env?: Record<string, string | undefined>; home?: string } = {}) {
  const override = str(env?.[RACCOON_DESKTOP_DIR_ENV], "").trim();
  const dir = override !== "" ? override : join(str(home, ""), RACCOON_DESKTOP_HOME_DIR, "config");
  return join(dir, RACCOON_DESKTOP_FILE);
}

/**
 * Turn one parsed document into a credential, or say why it is not one. Kept
 * apart from the I/O so the table of refusals is testable without a filesystem.
 * @param {unknown} parsed - the JSON document.
 * @param {() => number} [now] - the clock (injectable, so a test can sit on either side of `exp`).
 * @param {number} [leadMs] - the freshness margin.
 * @returns {object} `{ ok: true, credential, expiresAtMs }` or `{ ok: false, reason }`.
 */
export function raccoonDesktopCredentialFrom(parsed: unknown, now: () => number = Date.now, leadMs: number = RACCOON_DESKTOP_LEAD_MS) {
  const source = obj(parsed);
  // The archived contract records three names the App's own reader accepts for
  // the access token; accepting the same set costs nothing and stops a version
  // skew from reading as "not logged in".
  const accessToken = typeof source.access_token === "string" ? source.access_token
    : typeof source.accessToken === "string" ? source.accessToken
      : typeof source.token === "string" ? source.token
        : "";
  if (accessToken.trim() === "") return { ok: false as const, reason: RACCOON_DESKTOP_REASON.NO_TOKEN };
  const expiresAtMs = decodeRaccoonJwtExpMs(accessToken);
  if (expiresAtMs === undefined) return { ok: false as const, reason: RACCOON_DESKTOP_REASON.NO_EXPIRY };
  if (now() >= expiresAtMs - leadMs) return { ok: false as const, reason: RACCOON_DESKTOP_REASON.EXPIRED };
  return {
    ok: true as const,
    expiresAtMs,
    // The shape `raccoon-store.ts` resolves for every consumer. Two fields are
    // fixed by measurement rather than by the file: `refreshToken` is EMPTY (an
    // empty one is what makes a refresh attempt refuse locally instead of
    // knocking on the gateway and burning the App's token), and
    // `officeIdentity` is EMPTY (the header mapping above: the file's literal
    // `"personal"` is not an org code).
    credential: {
      accessToken,
      refreshToken: "",
      expiresAtMs,
      officeIdentity: "",
      nickname: ""
    }
  };
}

/**
 * Read the App's credential file. Never throws: every failure is a
 * `{ ok: false, reason }` the panel can word, because "the App is closed / not
 * installed / just rotated its token" is a normal state, not an error.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] - environment for the path override.
 * @param {string} [options.home] - home directory for the default path.
 * @param {string} [options.path] - explicit file path (tests; skips derivation).
 * @param {object} [options.fs] - injected `{ readFile, stat }` (tests).
 * @param {() => number} [options.now] - the clock.
 * @param {number} [options.leadMs] - freshness margin, default {@link RACCOON_DESKTOP_LEAD_MS}.
 * @param {boolean} [options.noCache] - bypass the stat-keyed cache (tests).
 * @returns {Promise<object>} `{ ok: true, credential, expiresAtMs, origin }` or `{ ok: false, reason }`.
 */
export async function readRaccoonDesktopCredential(options: {
  env?: Record<string, string | undefined>;
  home?: string;
  path?: string;
  fs?: { readFile?: (path: string, encoding: string) => Promise<string>; stat?: (path: string) => Promise<any> };
  now?: () => number;
  leadMs?: number;
  noCache?: boolean;
} = {}) {
  const now = options.now ?? Date.now;
  const leadMs = options.leadMs ?? RACCOON_DESKTOP_LEAD_MS;
  // Per-field defaulting rather than `options.fs ?? { readFile, stat }`: an
  // injected partial (a test stubbing only one of the two) would otherwise
  // type as, and be, a possibly-undefined callable.
  const readImpl = options.fs?.readFile ?? readFile;
  const statImpl = options.fs?.stat ?? stat;
  const path = options.path ?? raccoonDesktopAuthPath({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.home !== undefined ? { home: options.home } : {})
  });

  let info = null;
  try {
    info = await statImpl(path);
  } catch (error: any) {
    return { ok: false as const, reason: error?.code === "ENOENT" ? RACCOON_DESKTOP_REASON.MISSING : RACCOON_DESKTOP_REASON.UNREADABLE };
  }
  if (typeof info?.size === "number" && info.size > RACCOON_DESKTOP_MAX_BYTES) {
    return { ok: false as const, reason: RACCOON_DESKTOP_REASON.TOO_LARGE };
  }

  // The cache is keyed on (path, mtime, size) — which is also the answer to
  // "did the App rotate its token while we were running?": a rewrite moves the
  // mtime, so the next read re-parses and the panel FOLLOWS the App instead of
  // holding a snapshot of it. Failures are deliberately not cached: a rename in
  // flight must not stick for a TTL.
  const cacheKey = `${path}|${String(info?.mtimeMs)}|${String(info?.size)}`;
  if (options.noCache !== true && cache !== null && cache.key === cacheKey) return cache.value;

  let text = "";
  try {
    text = await readImpl(path, "utf8");
  } catch {
    return { ok: false as const, reason: RACCOON_DESKTOP_REASON.UNREADABLE };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false as const, reason: RACCOON_DESKTOP_REASON.MALFORMED };
  }
  const decoded = raccoonDesktopCredentialFrom(parsed, now, leadMs);
  const outcome = decoded.ok === true
    ? { ok: true as const, credential: decoded.credential, expiresAtMs: decoded.expiresAtMs, origin: RACCOON_ORIGIN_DESKTOP }
    : { ok: false as const, reason: decoded.reason };
  if (options.noCache !== true) cache = { key: cacheKey, value: outcome };
  return outcome;
}

/** Drop the read cache (after an out-of-band edit, or between tests). */
export function forgetRaccoonDesktopCache() {
  cache = null;
}
