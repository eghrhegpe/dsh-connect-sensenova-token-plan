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
  /** Which roster the tab is drawing: the gateway catalogue or the built-in table. */
  modelsSource?: "live" | "fallback";
  models?: RaccoonModel[];
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

  return h(
    "div",
    null,
    h(
      "div",
      { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginBottom: 12 } },
      tt("raccoon.desc")
    ),
    // The provider switch (opt-in, default off). It decides whether the Raccoon
    // models are registered with DSH at all.
    h(
      "label",
      { style: { display: "flex", gap: 8, alignItems: "center", margin: "0 0 12px", cursor: loginBusy ? "wait" : "pointer" } },
      h("input", { type: "checkbox", checked: enabled, disabled: loginBusy, onChange: () => void toggle(!enabled) }),
      h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, tt("raccoon.switch"))
    ),
    // Registration status: the switch says "wants", this line says "is".
    // A registration failure stays visible even while the switch is OFF —
    // hiding it behind `enabled` is the same dead-end as the account editor
    // used to be: a failed state with no visible affordance to act on it.
    // When the switch is on but no login exists yet, the unregistered line
    // must say THAT (a "tick the switch" nudge at an already-ticked switch
    // is the same lie `llm.registeredPending` used to tell).
    state !== null
      ? state.providerRegistered === true
        ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, role: "status" },
            format(tt("raccoon.registered"), { count: count(models.length) }))
        : state.providerError !== undefined && state.providerError !== ""
          ? h("div", { style: S.formError, role: "alert" }, state.providerError)
          : enabled && !loggedIn
            ? h("div", { style: { ...S.muted, fontSize: 12 } }, tt("raccoon.awaitingLogin"))
            : h("div", { style: { ...S.muted, fontSize: 12 } }, tt("raccoon.unregistered"))
      : null,
    // The login half: a WeChat QR the tab encodes locally, or the login
    // result line once the walk settles. While a walk is in flight the QR
    // (from the route's shared in-flight scan) IS the waiting indicator —
    // the button alone already shows the busy state, so there is no second
    // "waiting" line beside it.
    h(
      "div",
      { style: { ...S.card, marginTop: 4 } },
      loggedIn
        ? h(
            "div",
            null,
            // An expired access token is a DIFFERENT fact from "not logged in":
            // the credential row still exists (and the registration may well be
            // up), so `loggedIn` alone reads as healthy while every request
            // 401s. Surface the expiry as an alert with its own affordance.
            state?.credentialExpired === true
              ? h("div", { style: { ...S.formError, fontSize: 13 }, role: "alert" },
                  nick === "" ? tt("raccoon.expiredPlain") : format(tt("raccoon.expired"), { nick }))
              : h("div", { style: { fontSize: 13 }, role: "status" },
                  nick === "" ? tt("raccoon.loggedInPlain") : format(tt("raccoon.loggedIn"), { nick })),
            state?.credentialExpired === true
              ? h("button", {
                  type: "button",
                  style: S.button,
                  onClick: () => void startLogin(),
                  disabled: loginBusy
                }, loginBusy ? tt("raccoon.loggingIn") : tt("raccoon.reLogin"))
              : h("button", { type: "button", style: S.button, onClick: () => void logout() }, tt("raccoon.logout"))
          )
        : h(
            "div",
            null,
            h("div", { style: { fontSize: 13 } }, tt("raccoon.notLogged")),
            // The QR encodes the scan URL the route is CURRENTLY waiting on
            // (it re-issues one per login; the tab's poll picks it up in
            // `state.scanUrl`), or the login button when no walk is in flight.
            state?.scanUrl !== undefined && state?.scanUrl !== ""
              ? qrImageOf(state.scanUrl)
              : null,
            h("button", {
              type: "button",
              style: S.button,
              onClick: () => void startLogin(),
              disabled: loginBusy
            }, loginBusy ? tt("raccoon.loggingIn") : tt("raccoon.login"))
          )
    ),
    loginNote !== null
      ? h("div", { style: { ...S.formNote, fontSize: 12, marginTop: 8 }, role: "status" }, loginNote)
      : null,
    // The balance and the roster the adapter offers.
    loggedIn
      ? h(
          "div",
          { style: { marginTop: 12 } },
          h(
            "div",
            { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
            // `null` is "the gateway did not answer", not "zero". Reading it as
            // 0 would claim a balance the panel never fetched — the exact lie
            // the roster block refuses to tell, so say "unknown" instead, and
            // quote the route's own reason when it has one.
            typeof state?.balance === "number"
              ? format(tt("raccoon.balance"), { balance: count(state.balance) })
              : state?.balanceDetail !== undefined && state?.balanceDetail !== ""
                ? format(tt("raccoon.balanceUnknownDetail"), { detail: state.balanceDetail })
                : tt("raccoon.balanceUnknown")
          ),
          // The gateway's own split of the total (the parts it declared):
          // "其中 每日 1,129 · 奖励 9,000". Only drawn when a read carried it.
          breakdownParts !== ""
            ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 8 } },
                format(tt("raccoon.balanceBreakdown"), { parts: breakdownParts }))
            : null,
          // The credential's expiry, beside the balance it guards: `when()`
          // carries the day across midnight (a 22:00 rotation expires 01:00 —
          // a bare time would read as today), and it stays drawn while the
          // token is lapsed so the expired alert above is dated, not vague.
          expiresAt !== null
            ? h(
                "div",
                { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status" },
                format(tt("raccoon.expiresAt"), { date: when(expiresAt / 1e3) })
              )
            : null,
          // The re-scan deadline: until the refresh token lives the panel
          // renews itself; after it, the QR code is the only way back.
          refreshAt !== null
            ? h(
                "div",
                { style: { ...S.muted, fontSize: 12, marginBottom: 8 }, role: "status" },
                format(tt("raccoon.refreshUntil"), {
                  date: when(refreshAt / 1e3),
                  days: Math.max(1, Math.round((refreshAt - Date.now()) / 86_400_000))
                })
              )
            : null,
          models.length > 0
            ? h(RaccoonRoster, { models, tt, source: state?.modelsSource })
            : null
        )
      : null
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
 * over an indented parameter line), because the data was already there: the
 * gateway's catalogue row carries `context_window` / `max_output_tokens`, the
 * Host has normalized them all along, and only this component was dropping
 * them — a name-only row reads as a stub beside the sibling list, not as a
 * deliberate minimalism. What it does NOT carry is the thinking ladder (see
 * the note in the row builder): that would be inventing a fact.
 * @param {object} props
 * @param {RaccoonModel[]} props.models - the rows the route reported.
 * @param {import("./runtime.ts").Tt} props.tt - the dictionary.
 * @param {("live"|"fallback")?} [props.source] - which table these rows came
 *   from; a silent fallback is named so the panel cannot read the built-in
 *   table as the gateway's catalogue.
 * @returns {unknown} the roster list element.
 */
export function RaccoonRoster({ models, tt, source }: { models: RaccoonModel[]; tt: Tt; source?: "live" | "fallback" }): unknown {
  const rows = Array.isArray(models) ? models : [];
  return h(
    "div",
    { style: S.modelPanel },
    h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, format(tt("raccoon.models"), { count: count(rows.length) })),
    source === "fallback"
      ? h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 6 } }, tt("raccoon.modelsFallback"))
      : null,
    h(
      "ul",
      { style: S.modelList, role: "list" },
      rows.map((row) => {
        const id = String(row?.id ?? "");
        const label = String(row?.name ?? id);
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
          { key: id, style: S.modelRow },
          // `modelRow` is a COLUMN (a head line over an optional parameter line,
          // the roster's shape), so the name and its badge must sit inside one
          // `modelRowHead` row — as bare siblings they stack, the badge drops to
          // its own line and the whole row reads as a broken two-column attempt.
          h(
            "div",
            { style: S.modelRowHead },
            h("span", { style: S.modelName, title: id }, label),
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
