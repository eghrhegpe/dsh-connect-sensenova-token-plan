/**
 * The Raccoon tab's frame, as a hook-free component.
 *
 * `raccoon-tab.ts` owns the tab's lifecycle — the poll loop, the cadence, the
 * four mutations — and this module owns what that lifecycle DRAWS. The split
 * is not cosmetic: the tab's state is internal `useState`, so the Node render
 * suite can mount the tab itself but only ever reach its logged-out frame
 * (that is what the old header comment admitted). Everything the reader sees
 * once signed in — the balance line and its declared split, both credential
 * clocks folded into that one line, the expired-credential ALERT, the
 * "已启用，登录后即可注册" wording, a registration failure that stays visible
 * while the switch is off — was therefore unasserted. Taking `state` as a prop
 * puts every one of those frames within reach of the same suite that already
 * pins the roster.
 *
 * All derivations stay HERE rather than in the tab, because they are pure
 * functions of `state` and `tt`: the tab keeps only what needs a hook.
 * @module dsh-connect-sensenova-token-plan/raccoon-card
 */

import { count, format, when } from "./format.ts";
import { toggleRaccoonModelIn } from "./models.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { qrDataUrl } from "./qr.ts";
import { RaccoonRoster } from "./raccoon-roster.ts";
import { RACCOON_SITE_URL } from "./const.ts";
import { S } from "./styles.ts";
import type { RaccoonState } from "../shared/wire.ts";

/**
 * The QR image is drawn at a fixed 208 px and the login window divides the
 * remaining-millis figure by one day's length; both numbers used to be bare
 * literals inside the component. Named here so a change is one edit, and the
 * render suite's `width: 208` assertions keep tracking intent rather than a
 * magic number.
 */
const QR_SIZE = 208;
const DAY_MS = 86_400_000;

/**
 * The secret-free state the /raccoon route answers.
 *
 * Re-exported from `src/shared/wire.ts` — the ONE declaration both halves read,
 * so the second upstream's wire shape finally has a counterpart on the Host
 * side to be checked against. Re-exported here to keep the panel's
 * `import type { RaccoonState } from "./raccoon-card.ts"` call sites working;
 * the shape itself is not owned by this file anymore.
 */
export type { RaccoonState };

/**
 * The QR image the login code encodes. The payload is the gateway's own
 * public login page URL (~144 bytes), which fits the v1–10/M capacity the
 * local encoder supports; `buildQrMatrix` throwing is the out-of-range
 * signal, and the tab then falls back to the plain URL text.
 * @param {string|null|undefined} scanUrl - the URL the route is waiting on.
 * @returns {unknown} an `<img>`, the URL as text, or null when there is none.
 */
function qrImageOf(scanUrl: string | null | undefined): unknown {
  if (typeof scanUrl !== "string" || scanUrl === "") return null;
  try {
    return h("img", {
      src: qrDataUrl(scanUrl, { size: QR_SIZE }),
      alt: "WeChat QR",
      width: QR_SIZE,
      height: QR_SIZE,
      style: { display: "block", margin: "8px 0", borderRadius: 4 }
    });
  } catch {
    // Out of the supported capacity: the URL itself is still scannable by
    // opening it, so show it as text.
    return h("code", { style: { ...S.muted, fontSize: 12, wordBreak: "break-all" } }, scanUrl);
  }
}

/**
 * The Raccoon tab's card tree.
 * @param {object} props
 * @param {RaccoonState|null} props.state - the route's last answer, or null
 *   before the first one lands.
 * @param {Tt} props.tt - the dictionary.
 * @param {boolean} props.loginBusy - the login POST is in flight (short: the
 *   route answers as soon as it has issued a scan).
 * @param {string|null} props.loginNote - a login/switch error or walk outcome.
 * @param {string|null} props.modelsNote - the pushed-model save's result.
 * @param {boolean} props.idsBusy - a pushed-model save is in flight.
 * @param {() => void} props.onLogin - start a scan.
 * @param {() => void} props.onLogout - forget the credential.
 * @param {(enabled: boolean) => void} props.onSwitch - flip the opt-in switch.
 * @param {(ids: string[]) => void} props.onIds - save the pushed-model list.
 * @returns {unknown} the tab's card tree.
 */
export function RaccoonCard({
  state, tt, loginBusy, loginNote, modelsNote, idsBusy, onLogin, onLogout, onSwitch, onIds
}: {
  state: RaccoonState | null;
  tt: Tt;
  loginBusy: boolean;
  loginNote: string | null;
  modelsNote: string | null;
  idsBusy: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onSwitch: (enabled: boolean) => void;
  onIds: (ids: string[]) => void;
}): unknown {
  const enabled = state?.enabled === true;
  const loggedIn = state?.loggedIn === true;
  // A scan is waiting on the phone. The ROUTE owns that fact (and the walk's
  // deadline), so nothing here holds a timer.
  const scanning = state?.loginStatus === "scanning";
  // What disables the login controls. The POST itself returns at once, so the
  // WAIT is the scan, not the request: without it in the condition the button
  // would re-enable while its own QR is still on screen.
  const waiting = loginBusy || scanning;
  // The gateway's login response does not always carry a nickname; rendering
  // "已登录：" with an empty tail reads as broken, so a blank nick drops the
  // suffix rather than showing a dangling colon.
  const nick = String(state?.nickname ?? "");
  const models = Array.isArray(state?.models) ? state.models : [];
  // The credential's own clock (the JWT `exp` the route re-reads after any
  // in-flight rotation): rendered next to the balance it guards.
  const expiresAt = typeof state?.expiresAtMs === "number" ? state.expiresAtMs : null;
  // The refresh token's window: the deadline after which ONLY a re-scan gets
  // back in. `when()` carries the day across midnight.
  const refreshAt = typeof state?.refreshExpiresAtMs === "number" ? state.refreshExpiresAtMs : null;
  // The gateway's split of the total, as parts it actually declared. A zero
  // part is still a figure worth showing (it is a fact, not a gap).
  const breakdown = state?.balanceBreakdown;
  const breakdownParts = [
    breakdown?.daily !== undefined ? format(tt("raccoon.partDaily"), { n: count(breakdown.daily) }) : null,
    breakdown?.reward !== undefined ? format(tt("raccoon.partReward"), { n: count(breakdown.reward) }) : null,
    breakdown?.monthly !== undefined ? format(tt("raccoon.partMonthly"), { n: count(breakdown.monthly) }) : null,
    breakdown?.topup !== undefined ? format(tt("raccoon.partTopup"), { n: count(breakdown.topup) }) : null
  ].filter(Boolean).join(" · ");

  // The signed-in frame's bookkeeping is ONE status element (the render suite
  // pins `meta.length === 1` on it), but one element is not one flat line: the
  // balance is the headline the user came to read and the declared split plus
  // the two credential clocks are its supporting detail. They used to be four
  // same-weight spans concatenated into a 12px run-on sentence, which is how a
  // tab reads as unfinished beside its siblings — the quota tab leads the same
  // KIND of fact with a 18px/650 tabular figure (S.quotaRemaining). So the
  // balance now takes that weight and the rest drops to a caption under it, all
  // still inside the single `role="status"` node the fold requires.
  const balanceText = typeof state?.balance === "number"
    ? format(tt("raccoon.balance"), { balance: count(state.balance) })
    : state?.balanceDetail !== undefined && state?.balanceDetail !== ""
      ? format(tt("raccoon.balanceUnknownDetail"), { detail: state.balanceDetail })
      : tt("raccoon.balanceUnknown");
  // A drained balance is the alarm, not decoration — the same rule the quota
  // headline applies at its error threshold. Only zero/negative is asserted:
  // the warn band a percentage has (70/90) has no honest equivalent for an
  // absolute credit figure whose normal magnitude this client is not told, so
  // a guessed "low" threshold would be a number invented below the wire.
  const balanceTone = typeof state?.balance === "number" && state.balance <= 0
    ? S.statError
    : null;
  const captionParts: unknown[] = [];
  if (loggedIn) {
    if (breakdownParts !== "") {
      captionParts.push(h("span", { key: "breakdown" }, breakdownParts));
    }
    if (expiresAt !== null) {
      captionParts.push(h("span", { key: "exp" }, `${breakdownParts !== "" ? " · " : ""}${format(tt("raccoon.expiresAt"), { date: when(expiresAt / 1e3) })}`));
    }
    if (refreshAt !== null) {
      const days = Math.max(1, Math.round((refreshAt - Date.now()) / DAY_MS));
      captionParts.push(h("span", {
        key: "refresh",
        title: format(tt("raccoon.refreshTip"), { days })
      }, ` · ${format(tt("raccoon.refreshUntil"), { date: when(refreshAt / 1e3) })}`));
    }
  }

  // The login row's status text: an expired access token is a DIFFERENT fact
  // from "not logged in" — the credential row still exists (and the
  // registration may well be up), so `loggedIn` alone reads as healthy while
  // every request 401s. The expiry renders as an alert, not plain status.
  const loginStatus = loggedIn
    ? (state?.credentialExpired === true
        ? { alert: true, text: nick === "" ? tt("raccoon.expiredPlain") : format(tt("raccoon.expired"), { nick }) }
        : { alert: false, text: nick === "" ? tt("raccoon.loggedInPlain") : format(tt("raccoon.loggedIn"), { nick }) })
    : { alert: false, text: tt("raccoon.notLogged") };

  // The roster header carries the registration chip, so the standalone
  // "已注册 raccoon 提供方：N 个模型。" line — a fact the chip + the model
  // count already state — stops spending a line of its own. When the roster
  // is NOT on screen (logged out, or the gateway offered nothing), the old
  // wording keeps its job: it is the only place those states are named.
  const rosterVisible = loggedIn && models.length > 0;

  // The tab reads in the order the user acts: sign in first (nothing works
  // without a credential), then the opt-in switch that publishes the models,
  // then the account facts and the roster. The "what is this" paragraph is a
  // footer — a reader who got this far no longer needs it, and up top it only
  // pushed the actionable controls below the fold.
  return h(
    "div",
    null,
    // The login half: one compact card — the status text and its button share
    // a row (a one-line status never earned a full-width block), with the QR
    // riding below only while a scan is in flight.
    h(
      "div",
      { style: { ...S.card, padding: "10px 14px" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 12 } },
        h("div", {
          style: loginStatus.alert ? { ...S.formError, margin: 0, fontSize: 13 } : { fontSize: 13 },
          role: loginStatus.alert ? "alert" : "status"
        }, loginStatus.text),
        h("span", { style: S.spacer }),
        loggedIn
          ? (state?.credentialExpired === true
              ? h("button", {
                  type: "button",
                  style: S.button,
                  onClick: onLogin,
                  disabled: waiting
                }, waiting ? tt("raccoon.loggingIn") : tt("raccoon.reLogin"))
              : h("button", { type: "button", style: S.button, onClick: onLogout }, tt("raccoon.logout")))
          : h("button", {
              type: "button",
              style: S.button,
              onClick: onLogin,
              disabled: waiting
            }, waiting ? tt("raccoon.loggingIn") : tt("raccoon.login"))
      ),
      // The QR encodes the scan URL the route is CURRENTLY waiting on (it
      // re-issues one per login; the tab's poll picks it up in `state.scanUrl`).
      !loggedIn && state?.scanUrl !== undefined && state?.scanUrl !== ""
        ? qrImageOf(state.scanUrl)
        : null
    ),
    loginNote !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 8 }, role: "status" }, loginNote)
      : null,
    // The provider switch (opt-in, default off). It decides whether the Raccoon
    // models are registered with DSH at all — the second step, after signing in.
    // It used to be a bare label floating in the column gap between the login
    // card and the balance line, with no surface of its own: a control with no
    // home. It now sits on a quiet inset row so it reads as a deliberate
    // setting, aligned to the card content it governs.
    h(
      "label",
      {
        style: {
          display: "flex", gap: 8, alignItems: "center", margin: "12px 0 0", padding: "8px 14px",
          borderRadius: 8, background: "var(--dsw-alias-bg-layer-1)", cursor: waiting ? "wait" : "pointer"
        }
      },
      h("input", { type: "checkbox", checked: enabled, disabled: waiting, onChange: () => onSwitch(!enabled), style: { accentColor: "var(--sensenova-brand, #6C5CE7)", margin: 0 } }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("raccoon.switch"))
    ),
    // A registration failure stays visible even while the switch is OFF —
    // hiding it behind `enabled` is the same dead-end as the account editor
    // used to be: a failed state with no visible affordance to act on it.
    state !== null && state.providerError !== undefined && state.providerError !== ""
      ? h("div", { style: S.formError, role: "alert" }, state.providerError)
      : null,
    // The balance is the headline the user came to read (one `role="status"`
    // node, as the render suite pins), with the declared split and the two
    // credential clocks folded into a caption under it — the quota tab's
    // headline-over-caption shape, applied to the second upstream.
    loggedIn
      ? h(
          "div",
          { style: { marginTop: 12 }, role: "status" },
          h("div", { style: { ...S.statHeadline, ...(balanceTone ?? {}) } }, balanceText),
          captionParts.length > 0
            ? h("div", { style: { ...S.statCaption, marginTop: 2 } }, ...captionParts)
            : null
        )
      : null,
    modelsNote !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 6 }, role: "status" }, modelsNote)
      : null,
    models.length > 0
      ? h(RaccoonRoster, {
          models,
          tt,
          source: state?.modelsSource,
          enabledIds: Array.isArray(state?.enabledModelIds) ? state.enabledModelIds : null,
          busy: idsBusy || waiting,
          registered: state?.providerRegistered === true,
          onToggle: (id: string) => {
            // The next curation is computed by the SHARED dialect primitive
            // (`models.ts`), never here. The hand-rolled version this replaces
            // was `current.filter((entry) => entry !== id)`: it mirrored the
            // uncheck direction and silently dropped the check one, so a model
            // switched off could never be switched back on — the list was a
            // one-way door, and nothing noticed because the checkbox renders
            // from state rather than from what the click posted.
            onIds(toggleRaccoonModelIn(state?.enabledModelIds, models.map((row) => String(row?.id ?? "")), id));
          }
        })
      : // Without the roster the old status wording is the only place the
        // "switch on but not yet registered" states are named — keep it.
        state !== null && !rosterVisible
          ? enabled && !loggedIn
            ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 10 } }, tt("raccoon.awaitingLogin"))
            : h("div", { style: { ...S.muted, fontSize: 12, marginTop: 10 } }, tt("raccoon.unregistered"))
          : null,
    // The "what is this" explanation is the tab's footer, not its lead: a
    // reader working top-down hits the actionable controls first, and the
    // background ("independent of the credit pools") lands once it can be
    // understood. The client download rides in the same footer — resident,
    // state-independent (the credits offer holds whether or not the panel
    // session is signed in), and the same visual contract as the API-key
    // form's official-site link.
    h(
      "div",
      { style: { ...S.muted, fontSize: 12, marginTop: 14 } },
      tt("raccoon.desc")
    ),
    h("a", { href: RACCOON_SITE_URL, target: "_blank", rel: "noreferrer", style: { color: "var(--dsw-alias-label-primary)", fontSize: 12, marginTop: 10, display: "inline-block", textDecoration: "underline", cursor: "pointer" } }, tt("raccoon.clientLink"))
  );
}
