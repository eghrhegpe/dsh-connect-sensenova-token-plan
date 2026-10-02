/**
 * The account route — the panel configures itself without editing `.env`.
 *
 * Part of the routes split (see `../routes.ts` for the family map). Two GET
 * answers (stored-state / forgot), one POST (sign in / forget): the form
 * never learns the password, and a rejected sign-in reports the platform's
 * own words plus the sanitized trace file.
 *
 * @module dsh-connect-sensenova-token-plan/routes/account
 */
import { name } from "../host-config.ts";
import { CODE } from "../codes.ts";
import { writeLoginTrace } from "../trace.ts";
import { str, optional, errMsg } from "../util.ts";
import { clearCoalescedFetch } from "../coalesced-fetch.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin } from "./http.ts";
import type { PluginError, Wiring } from "../types.ts";

/** The account route: the panel configures itself without editing `.env`. */
export const ACCOUNT_PATH = `/api/${name}/account`;

/**
 * Register the account route. Wiring subset: `settings`, `tokenStore`,
 * `cache`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Wiring} wiring - as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerAccountRoute(ctx: any, wiring: Wiring) {
  const { settings, tokenStore, cache, inflight } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      const method = request.method === undefined ? "POST" : request.method;
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // `forget: true` clears the account without logging in again; the grant
      // survives on its refresh token until it needs the password again.
      if (body.value.forget === true) {
        try {
          await tokenStore.forgetAccount();
        } catch (error) {
          // The state is spread FIRST: it carries its own `error` field, and
          // spreading it after this one would overwrite the real reason with
          // whatever the store last saw.
          writeJson(response, 200, {
            ...(await optional(tokenStore.state())),
            ok: false,
            error: errMsg(error)
          }, { "cache-control": "no-store" });
          return;
        }
        // The grant that just cleared answers the very next poll, so the cached
        // console responses from the previous account must not survive it.
        // (saveAccount does the same on its success path.)
        // Routed through `clearCoalescedFetch` rather than `cache.clear()`: the
        // map must be emptied AND its generation bumped, or a console flight
        // that started under the previous account and lands after this point
        // writes back under the still-current generation and is served to the
        // account that just signed in.
        clearCoalescedFetch(cache, inflight);
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        await tokenStore.saveAccount({ username: body.value.username, password: body.value.password });
        // The success trace is persisted through `onTrace`; no path is owed
        // to the panel for a sign-in that worked.
      } catch (e) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable. The extra
        // fields are the shape `pluginError` attaches (types.PluginError) —
        // a non-pluginError throw simply has none of them, which every read
        // below already handles with its own fallback.
        const error = e as Partial<PluginError>;
        const traceFile = await writeLoginTrace(error?.trace, str(error?.code, CODE.AUTH_ERROR));
        writeJson(response, 200, {
          ...(await optional(tokenStore.state())),
          ok: false,
          code: str(error?.code, CODE.AUTH_ERROR),
          error: errMsg(error),
          // The platform's own words ride along so the panel can show them
          // beneath the classified line.
          ...(error?.detail === undefined ? {} : { detail: String(error.detail) }),
          // The sanitized hop-by-hop record of this attempt: the panel links
          // to it, and a support question becomes answerable.
          ...(traceFile !== null ? { traceFile } : {}),
          // When the platform names a wait, the panel greys the form out for
          // that long: retrying inside the window is what extends a lockout.
          ...(typeof error?.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {})
        }, { "cache-control": "no-store" });
        return;
      }
      // The grant that just landed answers the very next poll, so the cached
      // console responses from the previous account must not survive it.
      // Generation-bumping clear — see the note on the forget branch above.
      clearCoalescedFetch(cache, inflight);
      writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
    }, settings.allowedHosts)
  });
}
