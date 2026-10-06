// @ts-check
/**
 * The panel's own reading and decision — the real module, not a copy.
 *
 * This logic used to be tested through a hand-written copy called
 * `panelDecision`, described in its own comment as "mirrored from PanelPage".
 * A mirror is a promise nobody keeps: the copy tests one thing and the panel
 * runs another, and the two drift silently the moment either side is edited.
 * That drift was not hypothetical here — the mirror had no notion of the
 * throttling fields (`retryAfterMs`, `needsUserAction`), so the greying-out
 * behaviour added to fix the account lockout was never actually covered.
 *
 * The second attempt cut the logic out of `client.js`'s source with
 * balanced-brace walks and evaluated the snippets with `new Function`. Better
 * than a mirror — but its anchors were the client's FORMATTING: a renamed
 * variable or a moved brace broke the checks for reasons unrelated to
 * behaviour, and the module was quietly a mini-compiler over text.
 *
 * This version loads the client SOURCE (`src/client/index.ts`, via
 * `client-surface.js`) as a module and calls the functions the browser itself
 * calls. There is no anchor to maintain: if
 * the panel changes, these checks follow automatically — which is the entire
 * point. The exported names are unchanged, so the suites that consume them
 * did not have to change with the mechanism.
 * @module dsh-connect-sensenova-token-plan/panel-decision
 */

import { surface } from "./client-surface.js";

/** What the panel can render in its empty state. */
export const RENDER = {
  /** Show the account form: the user can fix this themselves. */
  FORM: "AccountForm",
  /** Show the read-only panel body (pools and trend). */
  PANELS: "pools",
  /** Nothing but an explanation — a config error no login can fix. */
  TEXT: "text-only"
};

/**
 * The panel's own reading of a snapshot body, as the browser defines it.
 * @type {(body: unknown) => {data: object|null, error: object|string|null}}
 */
export const interpretSnapshot = surface.interpretSnapshot;

/**
 * The panel's own decision function, as the browser defines it.
 * @type {(data: object|null, error: any, tt: Function) => object}
 */
export const viewOf = surface.viewOf;

/**
 * The panel's dictionaries, as the browser defines them.
 *
 * Exposed rather than re-declared for the same reason as the decision: a key
 * added to one language and not the other is invisible in the language that
 * has it, and shows as a raw key in the one that does not — so the equality
 * check has to read the real dictionaries.
 */
export const dictionaries = Object.freeze(surface.dictionaries);

/**
 * The failure-code tables the client branches on, as the browser defines
 * them. `test/panel.test.mjs` pins them against `src/host/codes.ts`: every key must be
 * a declared wire code, the form-excluded set must equal `NO_LOGIN_CODES`,
 * and every credential refusal must carry a line of text.
 */
export const tables = Object.freeze(surface.tables);

/** `tt`/`format` stand-ins: the decision is about WHICH key applies. */
const identity = (value) => value;

/**
 * The panel's view model for one snapshot, evaluated exactly as the browser
 * evaluates it.
 *
 * `tt` and `format` are identity here: the decision is about which dictionary
 * key applies, not the text behind it, and the dictionary is exercised
 * separately through {@link dictionaries}.
 *
 * @param {object|null} data - the snapshot, or null when none was read.
 * @param {object|string|null} error - a transport string or a structured failure.
 * @returns {{failure: object|null, auth: object|null, needsSetup: boolean,
 *   guidanceKey: string|null, guidance: string|null, render: string,
 *   canManageAccount: boolean, coolingMs: number|null, needsUserAction: boolean}}
 */
export function decidePanelView(data, error) {
  const view = viewOf(data, error, identity);
  return {
    failure: view.failure,
    auth: view.auth,
    needsSetup: view.needsSetup,
    guidanceKey: view.guidanceKey,
    guidance: view.guidance,
    render: view.needsSetup ? RENDER.FORM : (data === null ? RENDER.TEXT : RENDER.PANELS),
    // Mirrors `panel-page.ts` `authManage`: the login state and its editor
    // are shown UNCONDITIONALLY whenever the snapshot carries the Host's
    // auth block. Gating on `hasAccount` / `needsAccount` made the "middle
    // state" (grant still alive, saved account cleared) a dead end: the
    // full-screen setup form lives behind `!data`, and the section card
    // vanished with `hasAccount` — no re-entry path until the grant died.
    canManageAccount: view.auth !== null,
    coolingMs: typeof view.auth?.retryAfterMs === "number" && view.auth.retryAfterMs > 0
      ? view.auth.retryAfterMs
      : null,
    needsUserAction: view.auth?.needsUserAction === true
  };
}
