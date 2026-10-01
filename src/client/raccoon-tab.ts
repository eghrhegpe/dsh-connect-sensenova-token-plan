/**
 * The third panel tab: the Raccoon Work（商汤小浣熊）provider — "second
 * upstream provider" (ROADMAP §6.1).
 *
 * It is a SEPARATE data source from the Token Plan snapshot: this tab owns a
 * small, self-managed poll loop over the plugin's own `/raccoon` route (stop
 * when the tab leaves, one refresh on entry), and renders one card with, in
 * order: the provider switch (opt-in, default off), the WeChat-QR login
 * (a code the tab encodes into a QR image locally, so the panel never ships
 * an image dependency), the credit balance, and the model roster the adapter
 * offers. Nothing here touches the Token Plan pool semantics — the two tabs
 * are two providers, deliberately independent.
 *
 * Hook-based like `ApiKeyForm`/`ProviderSwitch`. The tab's own frame is
 * unreachable from the render suite (its data is internal state, so it always
 * renders the logged-out view); the roster it draws is therefore split into
 * the hook-free {@link RaccoonRoster}, which the suite CAN mount and pin, and
 * this tab's route is covered by `test/raccoon.test.mjs`.
 */
import { RACCOON_PATH } from "./const.ts";
import { count, format, tokenSize, when } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { qrDataUrl } from "./qr.ts";
import { S } from "./styles.ts";

/** One model row as the /raccoon route reports it. */
interface RaccoonModel {
  id?: string;
  name?: string;
  vision?: boolean;
  multiplier?: number;
  contextWindow?: number;
  maxOutputLength?: number;
}

/** The secret-free state the /raccoon route answers. */
interface RaccoonState {
  ok?: boolean;
  enabled?: boolean;
  switchSource?: string;
  loggedIn?: boolean;
  nickname?: string;
  /** The stored access token's JWT `exp`, in ms (absent when unknowable). */
  expiresAtMs?: number | null;
  /** Whether that token has lapsed — `loggedIn` can be true while this is true. */
  credentialExpired?: boolean;
  /** The refresh token's own window (≈30 days): how long until a re-scan. */
  refreshExpiresAtMs?: number | null;
  balance?: number | null;
  /** The gateway's split of the total — only parts it declared. */
  balanceBreakdown?: { daily?: number; reward?: number; monthly?: number; topup?: number } | null;
  /** The concrete reason a balance read came back empty (absent when fine). */
  balanceDetail?: string;
  /** Which roster the tab is drawing: the gateway catalogue ("live"), a read
   *  that succeeded but listed no visible model ("empty"), or a read that
   *  failed outright ("unreadable") — the last two both fall back to the
   *  built-in table, but they must be worded differently. */
  modelsSource?: "live" | "empty" | "unreadable";
  models?: RaccoonModel[];
  /** The saved pushed-model curation (`null`/absent = the whole roster). */
  enabledModelIds?: string[] | null;
  providerRegistered?: boolean;
  providerError?: string;
  error?: string;
  /** The in-flight QR scan the route last issued (cleared when it settles). */
  scanUrl?: string;
  scanCode?: string;
}

/** The cadence the tab polls at while open (balance + roster drift slowly). */
const RACCOON_POLL_MS = 60_000;

/**
 * The QR image the login code encodes. The payload is the gateway's own
 * public login page URL (~144 bytes), which fits the v1–10/M capacity the
 * local encoder supports; `buildQrMatrix` throwing is the out-of-range
 * signal, and the tab then falls back to the plain URL text.
 */
function qrImageOf(scanUrl: string | null | undefined): unknown {
  if (typeof scanUrl !== "string" || scanUrl === "") return null;
  try {
    return h("img", {
      src: qrDataUrl(scanUrl, { size: 208 }),
      alt: "WeChat QR",
      width: 208,
      height: 208,
      style: { display: "block", margin: "8px 0", borderRadius: 4 }
    });
  } catch {
    // Out of the supported capacity: the URL itself is still scannable by
    // opening it, so show it as text.
    return h("code", { style: { ...S.muted, fontSize: 12, wordBreak: "break-all" } }, scanUrl);
  }
}

/**
 * The Raccoon tab body.
 * @param {object} props
 * @param {Tt} props.tt - the dictionary.
 * @returns {unknown} the tab's card tree.
 */
export function RaccoonTab({ tt }: { tt: Tt }): unknown {
  const [state, setState] = useState<RaccoonState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The in-flight login walk: the route blocks up to its 5-minute deadline,
  // so the button goes to a "waiting" state and the result lands in `state`.
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [idsBusy, setIdsBusy] = useState(false);
  const alive = useRef(true);
  const pollMs = useRef(RACCOON_POLL_MS);

  const load = useCallback(async () => {
    const generation = pollMs.current;
    try {
      const response = await fetch(RACCOON_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok || !alive.current || generation !== pollMs.current) return;
      const body = (await response.json().catch(() => null)) as RaccoonState | null;
      if (!alive.current || generation !== pollMs.current) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      setError(null);
    } catch {
      if (alive.current && generation === pollMs.current) setError("unable to reach the Host");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // One loop owns the tab's polling: an immediate load on entry, then the
  // cadence; the timer stops on unmount (the tab may close at any time).
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive.current) void load();
    };
    run();
    timer = setInterval(run, pollMs.current);
    return () => {
      alive.current = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [load]);

  const toggle = useCallback(async (enabled: boolean) => {
    setLoginNote(null);
    try {
      const body = await postJsonOrThrow(RACCOON_PATH, { action: "switch", enabled });
      if (alive.current) setState((current) => (current ? { ...current, enabled: body.enabled === true, providerRegistered: body.providerRegistered === true } : current));
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.switchError"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [tt]);

  const startLogin = useCallback(async () => {
    setLoginBusy(true);
    setLoginNote(null);
    // The scan URL is issued by the POST walk but delivered by the GET: fire
    // ONE immediate fetch so the QR appears within ~100 ms of the click
    // (the 60 s cadence would leave a full minute of "nothing happened"),
    // then keep a fast poll while the walk is waiting, because that GET is
    // also how the tab learns the login has settled early.
    const quick = async () => {
      for (let i = 0; i < 150; i++) {
        await load();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void quick();
    // The route answers only when the walk settles (success / timeout), so
    // the button stays "waiting" the whole time and the result repicks the
    // card from the fresh state.
    try {
      const body = await postJson(RACCOON_PATH, { action: "login" });
      if (alive.current) {
        if (body?.ok === true) {
          setLoginNote(null);
        } else {
          setLoginNote(body?.error ?? tt("raccoon.error").replace("{error}", "login did not finish"));
        }
        void load();
      }
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setLoginBusy(false);
    }
  }, [load, tt]);

  const logout = useCallback(async () => {
    setLoginNote(null);
    try {
      await postJsonOrThrow(RACCOON_PATH, { action: "logout" });
      if (alive.current) void load();
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: why instanceof Error ? why.message : String(why) }));
    }
  }, [load, tt]);

  // One pushed-model toggle, applied at once: the route saves the id list and
  // republishes, and its answer (the same shape a GET reports) updates both
  // the curation and the registration status in one round-trip.
  const saveIds = useCallback(async (ids: string[]) => {
    setModelsNote(null);
    setIdsBusy(true);
    try {
      const body = await postJsonOrThrow(RACCOON_PATH, { action: "models", enabledModelIds: ids });
      if (alive.current && body?.ok === false) {
        setModelsNote(format(tt("raccoon.modelsError"), { error: typeof body.error === "string" ? body.error : "unknown" }));
        return;
      }
      if (alive.current) {
        setState((current) => (current
          ? { ...current, enabledModelIds: ids, providerRegistered: body?.providerRegistered === true, providerError: typeof body?.providerError === "string" ? body.providerError : undefined }
          : current));
        setModelsNote(tt("raccoon.modelsSaved"));
      }
    } catch (why) {
      if (alive.current) setModelsNote(format(tt("raccoon.modelsError"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setIdsBusy(false);
    }
  }, [tt]);

  const enabled = state?.enabled === true;
  const loggedIn = state?.loggedIn === true;
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

  // The logged-in frame's whole bookkeeping folds into ONE quiet meta line:
  // balance, its declared split, and both credential clocks. These are facts
  // the user glances at, not a form — three stacked lines of secondary text
  // read as clutter, not as diligence (the same lesson the quota tab's
  // "构成并入余额行" pass taught).
  const balanceText = typeof state?.balance === "number"
    ? format(tt("raccoon.balance"), { balance: count(state.balance) })
    : state?.balanceDetail !== undefined && state?.balanceDetail !== ""
      ? format(tt("raccoon.balanceUnknownDetail"), { detail: state.balanceDetail })
      : tt("raccoon.balanceUnknown");
  const metaLine: unknown[] = [];
  if (loggedIn) {
    metaLine.push(h("span", { key: "balance" }, balanceText));
    if (breakdownParts !== "") {
      metaLine.push(h("span", { key: "breakdown", style: { fontSize: 11 } }, `（${breakdownParts}）`));
    }
    if (expiresAt !== null) {
      metaLine.push(h("span", { key: "exp" }, ` · ${format(tt("raccoon.expiresAt"), { date: when(expiresAt / 1e3) })}`));
    }
    if (refreshAt !== null) {
      const days = Math.max(1, Math.round((refreshAt - Date.now()) / 86_400_000));
      metaLine.push(h("span", {
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
                  onClick: () => void startLogin(),
                  disabled: loginBusy
                }, loginBusy ? tt("raccoon.loggingIn") : tt("raccoon.reLogin"))
              : h("button", { type: "button", style: S.button, onClick: () => void logout() }, tt("raccoon.logout")))
          : h("button", {
              type: "button",
              style: S.button,
              onClick: () => void startLogin(),
              disabled: loginBusy
            }, loginBusy ? tt("raccoon.loggingIn") : tt("raccoon.login"))
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
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "12px 0 0", cursor: loginBusy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: loginBusy, onChange: () => void toggle(!enabled) }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("raccoon.switch"))
    ),
    // A registration failure stays visible even while the switch is OFF —
    // hiding it behind `enabled` is the same dead-end as the account editor
    // used to be: a failed state with no visible affordance to act on it.
    state !== null && state.providerError !== undefined && state.providerError !== ""
      ? h("div", { style: S.formError, role: "alert" }, state.providerError)
      : null,
    // The one meta line, then the roster the adapter offers.
    metaLine.length > 0
      ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: 10 }, role: "status" }, ...metaLine)
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
          busy: idsBusy || loginBusy,
          registered: state?.providerRegistered === true,
          onToggle: (id) => {
            // Toggle against the WHOLE roster: an uncurated list (`null`) reads
            // as "every model on", so the first uncheck materialises the list
            // from the roster minus that one id.
            const current = Array.isArray(state?.enabledModelIds) ? state.enabledModelIds : models.map((row) => String(row?.id ?? ""));
            void saveIds(current.filter((entry) => entry !== id));
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
    // understood.
    h(
      "div",
      { style: { ...S.muted, fontSize: 12, marginTop: 14 } },
      tt("raccoon.desc")
    )
  );
}

/**
 * The model roster the Raccoon adapter offers, as a hook-free component.
 *
 * Split out of {@link RaccoonTab} for the same reason `ModelRoster` is its own
 * component: the tab's data is internal state, so the render suite can only
 * ever reach the logged-out frame — a roster inlined there is unassertable,
 * and the row-shape regression that broke the draw card would sail through
 * again. Both rosters now share `S.modelRow`'s contract and are pinned by the
 * same check.
 *
 * The row is the SAME two-line shape as the Token Plan roster's (head line
 * over an indented parameter line), and since the pushed-model picker landed
 * it also shares the per-row checkbox: a tick decides whether the model is
 * pushed into DSH's list, an unticked row dims (`S.modelRowOff`), and the
 * handler is handed in from the tab exactly as `ModelRoster`'s is. What the
 * row does NOT carry is the thinking ladder (see the note in the row
 * builder): that would be inventing a fact.
 * @param {object} props
 * @param {RaccoonModel[]} props.models - the rows the route reported.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @param {("live"|"empty"|"unreadable")?} [props.source] - which table these
 *   rows came from; a silent fallback is named so the panel cannot read the
 *   built-in table as the gateway's catalogue.
 * @param {string[]?} [props.enabledIds] - the saved pushed-model curation;
 *   `null`/absent reads as "the whole roster pushes".
 * @param {boolean} [props.busy] - disables the checkboxes while a save or the
 *   login walk is in flight.
 * @param {boolean} [props.registered] - whether the provider pair is
 *   currently registered; the header chip says so.
 * @param {(id: string) => void} [props.onToggle] - the per-row toggle; absent
 *   (render suite), the checkboxes are display-only.
 * @returns {unknown} the roster list element.
 */
export function RaccoonRoster({ models, tt, source, enabledIds, busy, registered, onToggle }: {
  models: RaccoonModel[];
  tt: Tt;
  source?: "live" | "empty" | "unreadable";
  enabledIds?: string[] | null;
  busy?: boolean;
  registered?: boolean;
  onToggle?: (id: string) => void;
}): unknown {
  const rows = Array.isArray(models) ? models : [];
  const fallbackNote = source === "empty" ? tt("raccoon.modelsEmpty") : source === "unreadable" ? tt("raccoon.modelsFallback") : null;
  // `null` (the panel never curated) is "every model pushes", not "none does".
  const curated = Array.isArray(enabledIds) ? new Set(enabledIds) : null;
  return h(
    "div",
    { style: { ...S.modelPanel, marginTop: 10 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 } },
      h("span", { style: { ...S.muted, fontSize: 12, fontWeight: 600 } }, format(tt("raccoon.models"), { count: count(rows.length) })),
      fallbackNote !== null
        ? h("span", { style: { ...S.muted, fontSize: 11 } }, fallbackNote)
        : null,
      h("span", { style: S.spacer }),
      // The registration chip: the switch says "wants", this says "is", in the
      // spot the eye scans for state — the header's right edge.
      h("span", {
        style: {
          ...S.modelBadge,
          ...(registered === true ? { color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))" } : {})
        }
      }, registered === true ? tt("raccoon.registeredChip") : tt("raccoon.unregisteredChip"))
    ),
    h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 6 } }, tt("raccoon.pushHint")),
    h(
      "ul",
      { style: S.modelList, role: "list" },
      rows.map((row) => {
        const id = String(row?.id ?? "");
        const label = String(row?.name ?? id);
        const on = curated === null ? true : curated.has(id);
        // The credit rate reads as its own chip, drawn exactly like the Token
        // Plan roster's `×N` (0 is "free", not "×0" — a zero multiplier is a
        // fact about the model, not a rate of zero).
        const rate = typeof row?.multiplier === "number" ? row.multiplier : null;
        // Only figures the platform actually declares draw a segment, and the
        // THINKING LADDER is deliberately absent: this provider registers
        // `reasoning: false` (pi-ai cannot emit `extra_body.thinking`, the
        // gateway's only working channel), so quoting levels here would
        // promise a selector the DSH picker will never offer. An unsupported
        // fact is left out, never guessed at.
        const ctx = typeof row?.contextWindow === "number" && row.contextWindow > 0
          ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) })
          : null;
        const out = typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0
          ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) })
          : null;
        const meta = [ctx, out].filter(Boolean).join(" · ");
        return h(
          "li",
          { key: id, style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
          // `modelRow` is a COLUMN (a head line over an optional parameter line,
          // the roster's shape), so the checkbox, the name and its badge must
          // sit inside one `modelRowHead` row — as bare siblings they stack,
          // the badge drops to its own line and the whole row reads as a
          // broken two-column attempt.
          h(
            "div",
            { style: S.modelRowHead },
            h(
              "label",
              {
                style: {
                  display: "flex", alignItems: "center", gap: 8, flex: "0 1 auto",
                  minWidth: 0, cursor: busy ? "default" : "pointer"
                }
              },
              h("input", {
                type: "checkbox",
                checked: on,
                disabled: busy === true,
                style: S.modelCheck,
                "aria-label": label,
                onChange: onToggle ? () => onToggle(id) : undefined
              }),
              h("span", { style: S.modelName, title: id }, label)
            ),
            // `raccoon.rateTitle`, never `llm.rosterRateTitle`: the Token Plan
            // roster's rate is the operator's own pseudo figure and says so,
            // while this one is the gateway catalogue's declared field —
            // borrowing that tooltip would label real data as invented.
            rate !== null
              ? h("span", { style: S.modelRate, title: tt("raccoon.rateTitle") }, rate === 0 ? tt("raccoon.free") : `×${rate}`)
              : null,
            // The name hugs its rate chip (as in the Token Plan roster), so a
            // flexible spacer is what puts the badge on the right edge where
            // the eye looks for a state marker.
            h("span", { style: S.spacer }),
            row.vision === true ? h("span", { style: S.modelBadge }, tt("llm.rosterVision")) : null
          ),
          meta === "" ? null : h("div", { style: S.modelMeta }, meta)
        );
      })
    )
  );
}
