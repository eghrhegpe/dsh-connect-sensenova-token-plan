/**
 * The HTTP primitives shared by every route of the family: the JSON shape,
 * the bounded body reader, the standard refusals and the trust fence.
 *
 * Part of the routes split (see `../routes.ts` for the family map; the
 * token-store playbook was followed: behaviour frozen first — the suites ran
 * green against the `routes.ts` facade, unchanged, before and after the move).
 * Handlers keep exactly the behaviour they had inline; only the shared
 * wording and ceilings live here, so a route cannot drift its own 403 / 405.
 *
 * Nothing here imports a Host peer.
 *
 * @module dsh-connect-sensenova-token-plan/routes/http
 */
import { isAdmitted } from "../host-config.ts";

/** Family default response headers for a JSON route. */
export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** Write one JSON response with the family headers. */
export function writeJson(res: any, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
export const MAX_ACCOUNT_BODY_BYTES = 4096;

/** Ceiling on the curated allow-list: a catalogue this large is a posting accident. */
export const MAX_ENABLED_MODEL_IDS = 500;

/** Ceiling on a Raccoon action body: the login POST only needs the scan code. */
export const MAX_RACCOON_BODY_BYTES = 2048;

/**
 * Read a small JSON request body, refusing anything oversized.
 *
 * The account form is the only thing that posts here, so the ceiling is tiny
 * and the reader is deliberately dull: no content-type negotiation, no
 * streaming, just a bounded collect and a parse.
 * @param request - the incoming HTTP request.
 * @param limit - the byte ceiling.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
export async function readJsonBody(request: any, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/**
 * Refuse a request the trust fence rejects, with the one body the panel reads.
 *
 * Every route opens with the identical line, so the wording and the 403 shape
 * live in one place: a route that forgets the fence, or words it differently,
 * is now the odd one out rather than a second truth.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
export function refuseOrigin(response: any) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/**
 * Refuse a disallowed method with the family's 405 shape. A method refusal is
 * not a fresh answer, so it carries no `cache-control` (unlike a snapshot).
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
export function refuseMethod(response: any) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * Read and validate a JSON body, or answer 400 and signal the caller to stop.
 *
 * Collapses the read-then-400 block every POST route repeats. Returns the
 * `readJsonBody` result on success (callers keep reading `body.value`), or
 * `null` after the 400 was written — a `null` is the caller's cue to return.
 * @param request - the incoming HTTP request.
 * @param response - the outgoing HTTP response (written on failure).
 * @returns {Promise<object|null>} the read result, or null if a 400 was sent.
 */
export async function readJsonBodyOr400(request: any, response: any, limit = MAX_ACCOUNT_BODY_BYTES) {
  const body = await readJsonBody(request, limit);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: /** @type {{ok: false, error: string}} */ (body).error }, { "cache-control": "no-store" });
    return null;
  }
  return body;
}

/**
 * Wrap a route handler with the trust fence every route opens with.
 *
 * The seven handlers each repeated the identical `isAdmitted` block; this folds
 * it into one seam so a forgotten fence is impossible and the 403 wording
 * stays in {@link refuseOrigin}. A handler wrapped here must NOT repeat the
 * fence — doing so is only a second, dead guard.
 * @param handler - the route logic.
 * @param allowedHosts - the settings' allowed-hosts list the fence checks against.
 * @returns the fenced handler.
 */
export function withOrigin(handler: (request: any, response: any) => Promise<void>, allowedHosts: Set<string>) {
  return async (request: any, response: any) => {
    if (!isAdmitted(request, allowedHosts)) {
      refuseOrigin(response);
      return;
    }
    return handler(request, response);
  };
}

/**
 * Whether a request opted into the Raccoon 401-triage diagnostics (`?debug=1`).
 *
 * A retired scaffold: the 401 root-cause fix (Bearer dual-shape + pre-read
 * renewal gate + `/refresh`) has landed and no client renders the triage
 * fields, so an ordinary poll must not carry them. A query flag keeps the
 * capability without a config field (a patch change needs a restart) and
 * without widening every response.
 *
 * Only `1` / `true` opt in: `?debug=0` must stay quiet, and a malformed URL is
 * treated as "no".
 * @param {object} request - the incoming HTTP request.
 * @returns {boolean} whether the diagnostics were requested.
 */
export function wantsDiagnostics(request: any) {
  const url = typeof request?.url === "string" ? request.url : "";
  if (url === "") return false;
  try {
    const flag = new URL(url, "http://localhost").searchParams.get("debug");
    return flag === "1" || flag === "true";
  } catch {
    return false;
  }
}
