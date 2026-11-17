/**
 * The Raccoon BROWSER-AUTHORIZE login — the official desktop client's own
 * login chain, adopted by this plugin (ADR-020; evidence in
 * `docs/evidence/2026-11-17-authorize-loopback/`).
 *
 * Why this module exists: the QR-SCAN chain is dead on the upstream side —
 * the confirm page `/login/mp` has 404'd since 2026-11-04 (ROADMAP §6.1.10),
 * and a QR that cannot be confirmed can never log anyone in. The official
 * desktop client (build 2026-11-05, `resources/app.asar`) stopped using that
 * chain and logs in through the WEB instead: the system browser opens
 * `/authorize`, the user signs in ON THE PAGE (the page's own phone / WeChat
 * QR — a DIFFERENT, live link than the dead `/login/mp` route), consents,
 * and the issued one-time `authorization_code` is delivered back to the
 * caller — either the registered `office-raccoon://` protocol (the official
 * app only) or a LOOPBACK receiver on `127.0.0.1:<port>` (the Windows/Linux
 * compatibility mode, which a third party may host itself). This module is
 * the protocol half of that loopback mode: the receiver with the official
 * receiver's security rules, the code exchange, and the URL builder the
 * official page's own parser accepts.
 *
 * Mechanism reference, not port (ROADMAP §6.1): the wire facts were read out
 * of the official client's login sources — the 2026-11-05 build's desktop-login,
 * loopback-receiver, refresh-scheduler and iam-token helpers, the exact
 * asar paths recorded in docs/evidence/2026-11-17-authorize-loopback/INDEX.md
 * — and re-probed live 2026-11-17
 * (`/authorize` 200 with loopback params rendered into its boot data; the
 * exchange endpoint answering a bogus code with 400 `200035`; and the same
 * evening a REAL consent delivered its code to a loopback receiver and
 * exchanged — the `iss` the gateway signs is scheme-free, and it pairs the
 * IAM token with a refresh token). The receiver's
 * rules are the official receiver's RULES re-stated here — the loopback code
 * is a one-shot credential, and an open receiver is a credential-exchange
 * hole, so none of the seven checks is optional.
 *
 * The exchange lands the SAME credential the QR walk lands: the token pair
 * goes to the DSH credentials service through `raccoon-store.ts` (red lines
 * 1/2), never to this plugin's directory, git, or logs — and this module
 * prints no credential value: its failure results carry a REASON WORD, not
 * the body text.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-authorize
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { str, verbatim } from "./util.ts";
import {
  RACCOON_API_BASE,
  RACCOON_AUTH_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS
} from "./raccoon-consts.ts";
import {
  parseRaccoonEnvelope,
  decodeRaccoonJwtExpMs,
  extractRaccoonNickname
} from "./raccoon-http.ts";

/** The `/authorize` path the official client opens in the system browser. */
export const RACCOON_AUTHORIZE_PATH = "/authorize";

/**
 * The registered app the consent page shows (display name 「商汤小浣熊
 * 客户端」). The value is the official client's own `DESKTOP_AUTH_PARAMS`
 * literal (desktopLogin.js L12) — the one appname a live login was
 * completed with (2026-11-17 evidence). The page's parser whitelists three
 * appnames (办公小浣熊客户端 / 商汤小浣熊客户端 / Office Raccoon); all
 * others still parse, but the consent copy then quotes the UNKNOWN string,
 * so the proven one is the default.
 */
export const RACCOON_AUTH_APPNAME = "办公小浣熊客户端";

/** The loopback receiver's callback path — fixed by the official page. */
export const RACCOON_LOOPBACK_CALLBACK_PATH = "/auth/callback";

/**
 * The gateway's envelope code for "this authorization code is unknown,
 * expired, or already consumed" (probed 2026-11-17: a bogus code answers
 * HTTP 400 with exactly this; the official client's constant
 * `AUTHORIZATION_CODE_NOT_FOUND` is the same value). One re-start of the
 * flow is the only recovery — retrying the same code changes nothing.
 */
export const RACCOON_AUTHORIZATION_CODE_NOT_FOUND = 200035;

/**
 * The receiver's default wait: the official loopback's own default
 * (webLoginLoopback.js: `timeoutMs ?? 300000`). A browser sign-in that
 * includes a fresh phone login comfortably fits five minutes.
 */
export const RACCOON_AUTHORIZE_TIMEOUT_MS = 300_000;

/**
 * The loopback redirect the official page's parser will accept, as a
 * machine-checkable rule: `http://127.0.0.1:<port>/auth/callback` with a
 * 4–5 digit port ≥ 1024 and ≤ 65535. Re-stated from the page chunk's `E()`
 * (2026-11-17): a redirect the PAGE rejects would parse into a context and
 * only fail at delivery, so the builder refuses it up front instead.
 */
const RACCOON_LOOPBACK_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/;

/**
 * The `iss` an IAM token must carry. The official client computes it as
 * `new URL(LOGIN_URL).host + "/iam"` — a bare HOST, no scheme — and the live
 * exchange on 2026-11-17 confirms the gateway signs exactly that shape
 * (`iss: "xiaohuanxiong.com/iam"`). The scheme-free form is load-bearing:
 * `iss` is compared by equality, so a scheme-carrying expectation would
 * reject every real token.
 */
export const RACCOON_IAM_ISSUER = `${new URL(RACCOON_API_BASE).host}/iam`;

/**
 * Protocol recognition for the gateway's IAM tokens, exactly the official
 * client's rule (iamToken.js): the `iss` claim ends with `/iam`. No
 * signature is checked here — the server owns validity; this only decides
 * WHICH half of the success gate applies (the IAM half is gated on its own
 * claims and never REQUIRES a refresh — though the live gateway pairs one;
 * the legacy half must carry its refresh).
 * @param {unknown} token - a candidate JWT.
 * @returns {boolean}
 */
export function isRaccoonIamToken(token: unknown): boolean {
  if (typeof token !== "string" || token === "") return false;
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.iss === "string" && payload.iss.endsWith("/iam");
  } catch {
    return false;
  }
}

/**
 * The official `iamTokenIsValid` re-stated: same issuer, a non-blank `sub`,
 * a finite `exp` in the future — and no `Date` overflow (the official's last
 * clause rejects an `exp` so large that `new Date(exp*1000)` is not a date).
 * @param {string} token - the access token.
 * @param {string} issuer - the expected `iss` (default {@link RACCOON_IAM_ISSUER}).
 * @returns {boolean}
 */
export function raccoonIamTokenIsValid(token: string, issuer: string = RACCOON_IAM_ISSUER): boolean {
  if (typeof token !== "string" || token === "") return false;
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return claims?.iss === issuer
      && typeof claims.sub === "string"
      && claims.sub.trim() !== ""
      && typeof claims.exp === "number"
      && Number.isFinite(claims.exp)
      && claims.exp > Date.now() / 1000
      && !Number.isNaN(new Date(claims.exp * 1000).getTime());
  } catch {
    return false;
  }
}

/**
 * Build the `/authorize` URL one browser sign-in opens.
 *
 * Every constraint is the official page's own parser rule, checked up front:
 * a URL the page would reject (and print 「授权链接无效」 over) must not be
 * offered to the user — the failure then has a next step instead of a dead
 * end. No value here is secret; the `state` is a public CSRF token the
 * receiver will `timingSafeEqual` back.
 * @param {object} options
 * @param {number} options.port - the loopback port the receiver will listen on.
 * @param {string} options.state - the 64-hex state the receiver will expect.
 * @param {string} [options.appname] - the registered app to consent (default {@link RACCOON_AUTH_APPNAME}).
 * @param {string} [options.base] - the gateway origin (default {@link RACCOON_API_BASE}).
 * @returns {string} the full URL.
 * @throws {Error} a named violation, so the route can answer `ok:false` with it.
 */
export function buildRaccoonAuthorizeUrl({ port, state, appname = RACCOON_AUTH_APPNAME, base = RACCOON_API_BASE }: {
  port: unknown;
  state: unknown;
  appname?: unknown;
  base?: unknown;
}): string {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("authorize: the loopback port must be an integer in 1024..65535");
  }
  const redirect = `http://127.0.0.1:${port}${RACCOON_LOOPBACK_CALLBACK_PATH}`;
  if (!RACCOON_LOOPBACK_REDIRECT_RE.test(redirect)) {
    throw new Error("authorize: the loopback redirect must be http://127.0.0.1:<4-5 digit port>/auth/callback");
  }
  const expected = verbatim(state, "");
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("authorize: the state must be 64 lowercase hex characters");
  }
  const app = verbatim(appname, "");
  if (app === "" || app.length > 100) {
    throw new Error("authorize: the appname must be 1..100 characters");
  }
  const origin: string = str(base, RACCOON_API_BASE) !== "" ? str(base, "") : RACCOON_API_BASE;
  const url = new URL(origin);
  if (url.protocol !== "https:") {
    throw new Error("authorize: the gateway origin must be https");
  }
  url.pathname = RACCOON_AUTHORIZE_PATH;
  url.search = "";
  url.searchParams.set("login_source", "desktop");
  url.searchParams.set("appname", app);
  url.searchParams.set("desktop_callback", "loopback");
  url.searchParams.set("redirect", redirect);
  url.searchParams.set("state", expected);
  return url.toString();
}

/**
 * The loopback receiver's terminal result. `code` rides ONLY here, back into
 * the caller that exchanges it — it is never logged, written, or echoed into
 * a response body (a rejected callback answers with a REASON WORD; the code
 * value is the one credential-shaped string this module must not print).
 */
export interface RaccoonAuthorizeReceiverResult {
  ok: boolean;
  code?: string;
  reason?: "timeout" | "closed" | "failed";
}

/** One live loopback receiver, and its fate. */
export interface RaccoonAuthorizeReceiver {
  /** The state the receiver will expect back (64 hex, public). */
  state: string;
  /** The port the receiver is listening on. */
  port: number;
  /** The redirect target the /authorize URL carries. */
  redirect: string;
  /** The full /authorize URL to open in the system browser. */
  authorizeUrl: string;
  /** Settles once: the callback's code, or the terminal reason. */
  result: Promise<RaccoonAuthorizeReceiverResult>;
  /** Close the receiver now; the result settles `{ ok: false, reason: "closed" }`. */
  cancel(): void;
}

/**
 * Start the loopback receiver the /authorize page's callback lands on.
 *
 * The seven checks mirror the official receiver one for one — GET-only,
 * host equal to our own authority, the loopback source address, an `Origin`
 * that must equal the authorize origin when present, a `Sec-Fetch-Dest`
 * that must equal `document` when present, the exact callback path with a
 * query whose keys are a subset of `{code, state}` (each once), and a
 * `state` that is 64 hex and `timingSafeEqual` to ours. One-shot: the first
 * VALID callback wins, and once it is taken (or the receiver settles for
 * any reason) the port answers 409 to everything — a second delivery of the
 * same code must not re-exchange it. Rejections do NOT consume: a wrong
 * `state` or an extra key leaves the receiver open so the page can be
 * re-opened with a corrected URL — exactly the official's own behaviour.
 *
 * The factory is ASYNC because the port is only known after the OS
 * assigns one (`port 0`): the caller awaits it before handing the URL to
 * the browser, and by then the receiver is already listening — there is no
 * window in which the page can redirect into a port that is not ours yet.
 * A refused bind (a foreign process on a requested port) settles the result
 * as `failed` rather than throwing: the caller is mid-request and needs an
 * answer, and the failure it names is one the user can act on by re-clicking.
 * @param {object} [options]
 * @param {number} [options.port] - the port to listen on; `0` (default) lets
 *   the OS pick, which also keeps two receivers from colliding.
 * @param {string} [options.state] - a 64-hex state; generated when omitted.
 * @param {number} [options.timeoutMs] - the wait window (default {@link RACCOON_AUTHORIZE_TIMEOUT_MS}).
 * @param {string} [options.authorizationOrigin] - what a present `Origin`
 *   header must equal (default the gateway origin).
 * @param {string} [options.appname] - the consent app (default {@link RACCOON_AUTH_APPNAME}).
 * @param {string} [options.base] - the gateway origin for the URL (default {@link RACCOON_API_BASE}).
 * @returns {Promise<RaccoonAuthorizeReceiver>}
 */
export async function startRaccoonAuthorizeReceiver(options: {
  port?: unknown;
  state?: unknown;
  timeoutMs?: unknown;
  authorizationOrigin?: unknown;
  appname?: unknown;
  base?: unknown;
} = {}): Promise<RaccoonAuthorizeReceiver> {
  const state = options.state !== undefined && options.state !== null
    ? verbatim(options.state, "")
    : randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(state)) {
    throw new Error("authorize: the state must be 64 lowercase hex characters");
  }
  const authorizationOrigin = str(options.authorizationOrigin, "") !== "" ? str(options.authorizationOrigin, "") : RACCOON_API_BASE;
  const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : RACCOON_AUTHORIZE_TIMEOUT_MS;

  let settled = false;
  let consumed = false;
  let server: Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  // The settle function is built INSIDE the Promise executor (it owns
  // `resolve`), and the `await`s between the executor and the later call
  // sites make TS reset definite-assignment on a bare `let` — so the callers
  // see the `finish` wrapper below: a const that is defined from the start
  // and delegates to the executor-built `settleFn` (still `null` until the
  // executor runs, which it does on the very next tick at latest).
  let settleFn: ((value: RaccoonAuthorizeReceiverResult, hard?: boolean) => void) | null = null;
  const finish = (value: RaccoonAuthorizeReceiverResult, hard = true) => {
    settleFn?.(value, hard);
  };
  const result: Promise<RaccoonAuthorizeReceiverResult> = new Promise((resolve) => {
    // `hard` tears down the in-flight connections (a timeout, a failed bind,
    // or a user cancel: nothing owes them a response). The SUCCESS path must
    // be soft: the 200 the browser is reading is in flight, and a hard close
    // would hang it up mid-body — the browser would then report "connection
    // reset" on a login that actually succeeded.
    settleFn = (value, hard = true) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (server !== null) {
        if (hard) server.closeAllConnections?.();
        server.close();
      }
      resolve(value);
    };
  });

  const request = (req: IncomingMessage, res: ServerResponse) => {
    const authority = `127.0.0.1:${portOf()}`;
    const answer = (status: number, body: string) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(body);
    };
    if (settled || consumed) {
      // One-shot: after the valid callback was taken (or the receiver
      // settled) the port answers 409 — the code is single-use upstream, and
      // a second delivery must not re-exchange it.
      answer(409, "used");
      return;
    }
    // Every rejection names its RULE, not its input: the `code` value is a
    // credential and must not appear in a response body or a log line.
    let reason = "";
    let code: string | null = null;
    try {
      const raw = typeof req.url === "string" ? req.url : "/";
      if (req.method !== "GET") {
        reason = "method";
      } else if (req.headers.host !== authority) {
        reason = "host";
      } else if (req.socket.remoteAddress !== "127.0.0.1") {
        reason = "source";
      } else if (typeof req.headers.origin === "string" && req.headers.origin !== authorizationOrigin) {
        reason = "origin";
      } else if (typeof req.headers["sec-fetch-dest"] === "string" && req.headers["sec-fetch-dest"] !== "document") {
        reason = "fetch-dest";
      } else {
        const url = new URL(raw, `http://${authority}`);
        if (url.origin !== `http://${authority}` || url.pathname !== RACCOON_LOOPBACK_CALLBACK_PATH || url.hash !== "") {
          reason = "path";
        } else {
          const keys = [...url.searchParams.keys()];
          if (keys.some((key) => !(key === "code" || key === "state"))
            || url.searchParams.getAll("state").length !== 1
            || url.searchParams.getAll("code").length !== 1) {
            reason = "keys";
          } else {
            const receivedState = url.searchParams.get("state") ?? "";
            const receivedCode = (url.searchParams.get("code") ?? "").trim();
            const stateOk = /^[a-f0-9]{64}$/.test(receivedState)
              && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state));
            const codeOk = receivedCode !== "" && receivedCode.length <= 4096
              && !/[\x00-\x1f\x7f]/.test(receivedCode);
            if (!stateOk) {
              reason = "state";
            } else if (!codeOk) {
              reason = "code";
            } else {
              code = receivedCode;
            }
          }
        }
      }
    } catch {
      reason = "url";
    }
    if (code === null) {
      answer(400, `rejected: ${reason === "" ? "callback" : reason}`);
      return;
    }
    consumed = true;
    // Flush the 200 BEFORE the teardown: a hard close here would kill the
    // socket mid-body and read as a failed login to the browser (soft close
    // lets the in-flight response finish, then the server goes).
    answer(200, "authorized");
    // The one moment the code leaves the wire: into the caller, verbatim.
    finish({ ok: true, code }, false);
  };

  // `listen`'s callback reads the port it actually got (the requested port
  // when nonzero, the OS-assigned one when 0) — the URL and the authority
  // check both use it, so neither can drift from the socket.
  let assignedPort = 0;
  const portOf = () => assignedPort;
  timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
  timer.unref();
  server = createServer({ maxHeaderSize: 8192 }, request);
  server.on("error", () => finish({ ok: false, reason: "failed" }));
  const requestedPort = typeof options.port === "number" && Number.isInteger(options.port) && options.port > 0
    ? options.port
    : 0;
  if (requestedPort !== 0 && (requestedPort < 1024 || requestedPort > 65535)) {
    // A port the page's own parser would refuse (its rule is 1024..65535) is
    // a caller bug: throwing up front is the only shape with a next step.
    throw new Error("authorize: the requested port must be 0 (random) or in 1024..65535");
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server?.removeListener("error", onError);
      reject(error);
    };
    server?.once("error", onError);
    server?.listen(requestedPort, "127.0.0.1", () => {
      server?.removeListener("error", onError);
      const address = server?.address() ?? null;
      if (address === null || typeof address === "string") {
        reject(new Error("authorize: the loopback port did not bind"));
        return;
      }
      assignedPort = address.port;
      resolve();
    });
  }).catch(() => {
    // A refused bind already settled the result as `failed`; the object the
    // caller gets still carries the (unbound) URL so it can report the
    // failure with a next step, and `result` is the source of truth.
  });
  // The OS can assign a port the page would refuse (below 1024); that bind
  // is a dead end for the whole flow, so it settles `failed` and yields no
  // URL — the caller reports the failure and the user re-clicks.
  const portUsable = assignedPort >= 1024 && assignedPort <= 65535;
  if (!portUsable && assignedPort > 0) finish({ ok: false, reason: "failed" });
  const redirect = `http://127.0.0.1:${assignedPort}${RACCOON_LOOPBACK_CALLBACK_PATH}`;
  const authorizeUrl = portUsable
    ? buildRaccoonAuthorizeUrl({ port: assignedPort, state, appname: options.appname, base: options.base })
    : "";
  return {
    state,
    port: assignedPort,
    redirect,
    authorizeUrl,
    result,
    cancel() {
      finish({ ok: false, reason: "closed" });
    }
  };
}

/**
 * The exchange result. On `ok` the caller (the route) hands the pair to the
 * credential store. The IAM half does NOT carry a refresh token in the
 * official rule — the success gate never expects one there (the official
 * refresh scheduler refreshes IAM tokens with a ZERO advance window) — but
 * the live 2026-11-17 exchange answered an IAM token WITH a `refresh_token`
 * whose expiry equals the access token's (both 30 days), so the field is
 * pass-through: whatever the gateway pairs with the token is stored, and
 * `""` means the caller has nothing to rotate. The expiry claims ride along
 * so the store's read-back does not have to re-decode them. On refusal every field is the REASON, and no body text —
 * the body may echo the code it refused, and echoing it into the panel (or
 * a log) would print the credential.
 */
export interface RaccoonAuthorizeExchange {
  ok: boolean;
  reason?: "code_not_found" | "session_dead" | "server_error" | "network" | "invalid_response" | "refresh_missing" | "token_invalid";
  accessToken?: string;
  refreshToken?: string;
  iam?: boolean;
  accessExpiresAtMs?: number;
  refreshExpiresAtMs?: number;
  officeIdentity?: string;
  nickname?: string;
}

/**
 * Exchange a one-time authorization code for the token pair.
 *
 * The request is the official's own shape, byte for byte: `POST
 * {authApi}/login_with_authorization_code` with a single `Content-Type`
 * header and `{ authorization_code }` — the gateway's web-auth family, so
 * the numeric `code === 0` envelope applies. The success gate is the
 * official's too: an `access_token`, and EITHER a valid IAM token (no
 * refresh expected) OR a refresh token (legacy pair). Anything short of the
 * gate is a REFUSAL with a named reason, never a partial credential: saving
 * a half-pair would be a credential that rotates into nothing.
 * @param {string} code - the one-time authorization code (exchanged at most once; the gateway 400s a replay).
 * @param {object} [options]
 * @param {typeof fetch} [options.fetcher] - injected fetch (the suites stub it).
 * @param {string} [options.authApiBase] - default `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}`.
 * @param {string} [options.iamIssuer] - the `iss` an IAM token must carry (default {@link RACCOON_IAM_ISSUER}).
 * @returns {Promise<RaccoonAuthorizeExchange>}
 */
export async function exchangeRaccoonAuthorizationCode(
  code: unknown,
  options: {
    fetcher?: typeof fetch;
    authApiBase?: unknown;
    iamIssuer?: unknown;
  } = {}
): Promise<RaccoonAuthorizeExchange> {
  const token = verbatim(code, "");
  if (token === "") return { ok: false, reason: "invalid_response" };
  const authApiBase = str(options.authApiBase, "") !== "" ? str(options.authApiBase, "") : `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}`;
  const iamIssuer = str(options.iamIssuer, "") !== "" ? str(options.iamIssuer, "") : RACCOON_IAM_ISSUER;
  const effective = options.fetcher ?? globalThis.fetch;
  let response: Response;
  try {
    response = await effective(`${authApiBase}/login_with_authorization_code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_code: token }),
      // A deadline on the DEFAULT fetch only: an injected fetcher owns its
      // own aborting (the suites' stubs have none), and a signal passed to
      // one that ignores it would be pure ceremony.
      ...(options.fetcher === undefined ? { signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS) } : {})
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
  if (response.status === 401) return { ok: false, reason: "session_dead" };
  if (envelope.code === RACCOON_AUTHORIZATION_CODE_NOT_FOUND) return { ok: false, reason: "code_not_found" };
  if (!response.ok || envelope.code !== 0) return { ok: false, reason: "server_error" };
  const data = envelope.data ?? {};
  const accessToken = verbatim(data.access_token, "");
  if (accessToken === "") return { ok: false, reason: "invalid_response" };
  const iam = isRaccoonIamToken(accessToken);
  if (iam && !raccoonIamTokenIsValid(accessToken, iamIssuer)) {
    return { ok: false, reason: "token_invalid" };
  }
  const refreshToken = verbatim(data.refresh_token, "");
  if (!iam && refreshToken === "") {
    // A legacy (non-IAM) answer without a refresh token is not a credential
    // this store can keep: it is a one-way pair the gateway will not renew,
    // so it refuses rather than storing a login that dies at its own `exp`.
    return { ok: false, reason: "refresh_missing" };
  }
  const out: RaccoonAuthorizeExchange = { ok: true, accessToken, refreshToken, iam };
  const accessExp = decodeRaccoonJwtExpMs(accessToken);
  if (accessExp !== undefined) out.accessExpiresAtMs = accessExp;
  const refreshExp = refreshToken !== "" ? decodeRaccoonJwtExpMs(refreshToken) : undefined;
  if (refreshExp !== undefined) out.refreshExpiresAtMs = refreshExp;
  const officeIdentity = str(data.office_identity, "");
  if (officeIdentity !== "") out.officeIdentity = officeIdentity;
  const nickname = extractRaccoonNickname(data, accessToken);
  if (nickname !== "") out.nickname = nickname;
  return out;
}
