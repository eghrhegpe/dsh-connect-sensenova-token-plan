/**
 * The third panel tab: the Raccoon Work（商汤小浣熊）provider — "second
 * upstream provider" (ROADMAP §6.1).
 *
 * It is a SEPARATE data source from the Token Plan snapshot: this tab owns a
 * small, self-managed poll loop over the plugin's own `/raccoon` route (stop
 * when the tab leaves, one refresh on entry), and hands its state to
 * {@link RaccoonCard}, which draws the frame. Nothing here touches the Token
 * Plan pool semantics — the two tabs are two providers, deliberately
 * independent.
 *
 * What this module owns is the LIFECYCLE, which is the part that needs hooks:
 * the poll loop and its two cadences, the four callbacks that post to the
 * route, the unmount cleanup, and the state lift into the page header. What
 * the reader SEES lives in `raccoon-card.ts` / `raccoon-roster.ts` /
 * `model-row.ts` — all hook-free, so the render suite mounts the very trees
 * the browser draws (the tab's own frame is unreachable there by construction:
 * its data is internal state, so mounting the tab always renders the
 * logged-out view).
 */
import { RACCOON_PATH } from "./const.ts";
import { format, statedCadenceMs } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { RaccoonCard } from "./raccoon-card.ts";
import type { RaccoonState } from "./raccoon-card.ts";

/**
 * The cadence the tab opens with, before any answer has stated one.
 *
 * NOT the tab's cadence: the route states `pollSeconds` in every answer (it
 * owns the cache windows the poll has to respect) and that is what the loop
 * runs on. This is only what the very first frame uses, so it must equal the
 * value the Host is expected to state — pinned to `RACCOON_BALANCE_TTL_MS` by
 * `test/raccoon-status.test.mjs` B8, because an unpinned fallback is a second
 * home for the number this file no longer owns.
 */
export const RACCOON_POLL_MS = 60_000;
/**
 * The cadence while a scan is waiting, before any answer has stated one.
 *
 * The gateway's own client polls every 2 s, so a confirmed scan must be
 * noticed within a couple of seconds of it happening. It costs nothing when no
 * scan is in flight (the loop drops back to the slow cadence the moment the
 * route stops saying `scanning`), and it is bounded by the SERVER's deadline —
 * the tab holds no timer of its own that could outlive the walk. Pinned to the
 * route's `RACCOON_QR_POLL_INTERVAL_MS` by the same check as above.
 */
export const RACCOON_SCAN_POLL_MS = 2_000;

/**
 * The Raccoon tab body.
 * @param {object} props
 * @param {Tt} props.tt - the dictionary.
 * @returns {unknown} the tab's card tree.
 */
export function RaccoonTab({
  tt,
  onReportStatus
}: {
  tt: Tt;
  // A channel to the page's header: the raccoon tab is a SECOND upstream with
  // its own poll, so its freshness + refresher belong in the pinned header's
  // right cluster (the old global "刷新" only re-fetched the quota snapshot
  // and silently skipped this tab). The tab calls this with its latest
  // `updatedAt`/error on every successful GET — a state lift, so the header
  // re-renders live; passing `null` on unmount clears the cluster.
  onReportStatus?: (status: { updatedAt: number; error: string | null; onRefresh: () => void } | null) => void;
}): unknown {
  const [state, setState] = useState<RaccoonState | null>(null);
  // There is deliberately NO local `loading`/`error` state here. Both used to
  // exist as write-only pairs (`const [_error, setError] = …`) — the values
  // were never read, so a failed read updated nothing the user could see. The
  // failure now travels to the header through `report` below, which is the only
  // place with something to render it.
  // The login click's own round-trip: the route issues the scan and answers
  // straight away, so this is SHORT. The wait the user actually experiences is
  // the scan, which the route reports as `loginStatus:"scanning"`.
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [idsBusy, setIdsBusy] = useState(false);
  const alive = useRef(true);
  /**
   * Which read is allowed to write.
   *
   * The loop's cadence changes (60 s → 2 s when a scan starts) and every change
   * rebuilds it with an immediate load, so two reads can be in flight at once
   * and the SLOWER one can land last — putting the older answer on screen and
   * making the balance, the roster and the login status all step backwards.
   * `alive` alone cannot catch that: it says nothing about supersession. The
   * quota tab has carried the same guard all along; this one now does too,
   * because the two loops answer to the same problem.
   */
  const generation = useRef(0);
  /**
   * The time of the last SUCCESSFUL read — what the header's "更新于" shows.
   *
   * A failed read keeps it (the data is stale, not gone) but must still forward
   * the failure, so the header says so instead of presenting a stale timestamp
   * as if nothing were wrong.
   */
  const lastGoodAt = useRef(0);
  /**
   * The latest `load`, for the header's refresh button.
   *
   * `report` is memoized on `onReportStatus` alone — it has to be, or every
   * render would rebuild the poll loop below — so reading `load` inside it
   * directly would capture the FIRST render's copy (and that render's `tt`)
   * forever.
   */
  const loadRef = useRef<() => void>(() => {});

  // Stamp the header's freshness channel: `updatedAt` is the last GOOD read,
  // `err` the current failure (`null` when the last read worked).
  //
  // This used to be called only as `report(at, null)`; the failure paths wrote
  // to a local state that nothing rendered. An unreachable Host therefore left
  // the previous timestamp AND the previous roster on screen indefinitely while
  // the poll kept running — the "silently shows old data" outcome
  // `docs/AUTH.md` forbids for the token path, which applied here too.
  const report = useCallback((err: string | null) => {
    if (onReportStatus !== undefined && alive.current) {
      onReportStatus({ updatedAt: lastGoodAt.current, error: err, onRefresh: () => void loadRef.current() });
    }
  }, [onReportStatus]);

  const load = useCallback(async () => {
    const at = Date.now();
    const mine = (generation.current += 1);
    const isCurrent = () => alive.current && generation.current === mine;
    /** Record a failed read: forward it to the header, the only place that renders it. */
    const fail = (message: string) => {
      if (!isCurrent()) return;
      report(message);
    };
    try {
      const response = await fetch(RACCOON_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      // A superseded read says nothing; a CURRENT non-OK answer is a failure.
      // This used to `return` silently on any non-OK status, so a 401/500 left
      // the tab in its previous state forever while the poll continued. The
      // quota path maps 401/403 to `jwt_expired`; this is a separate upstream,
      // so the status itself is the honest report.
      if (!isCurrent()) return;
      if (!response.ok) {
        fail(`HTTP ${response.status}`);
        return;
      }
      const body = (await response.json().catch(() => null)) as RaccoonState | null;
      if (!isCurrent()) return;
      if (body === null || body.ok === false) {
        // A failed read does not reset the timestamp we already reported.
        fail(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        return;
      }
      setState(body);
      // A terminal walk outcome is delivered ONCE, so this is the only poll
      // that sees it — the note is the tab's whole account of a scan that
      // ended without the user being signed in. (`logged_in` needs no note:
      // the card itself changes, and the effect's immediate reload picks up
      // the freshly published roster.)
      const outcome = typeof body.loginStatus === "string" ? body.loginStatus : null;
      if (outcome === "timeout") setLoginNote(tt("raccoon.loginTimeout"));
      else if (outcome === "canceled") setLoginNote(tt("raccoon.loginCanceled"));
      else if (outcome === "failed") {
        setLoginNote(format(tt("raccoon.loginFailed"), {
          error: typeof body.loginError === "string" && body.loginError !== "" ? body.loginError : "unknown"
        }));
      } else if (outcome === "logged_in") setLoginNote(null);
      // Only a SUCCESS moves the timestamp the header shows, and it clears any
      // error the previous read reported.
      lastGoodAt.current = at;
      report(null);
    } catch {
      fail("unable to reach the Host");
    }
  }, [report, tt]);

  // The header's refresh button must reach the CURRENT `load`, not the first
  // render's — see `loadRef`.
  loadRef.current = () => void load();

  // A scan is waiting on the phone. The ROUTE owns that fact (and the walk's
  // deadline), so the tab has no timer of its own to leak: it simply polls
  // faster while the route says so, and drops back the moment it stops.
  const scanning = state?.loginStatus === "scanning";

  // The cadence is STATED by the Host in every answer (it owns the two cache
  // windows the poll has to respect), and the module constants are only what
  // the first frame uses before an answer has arrived — the same shape the
  // quota tab follows with the snapshot's `pollSeconds`, through the same
  // converter.
  const pollMs = statedCadenceMs(state?.pollSeconds, RACCOON_POLL_MS);
  const scanPollMs = statedCadenceMs(state?.scanPollSeconds, RACCOON_SCAN_POLL_MS);

  // One loop owns the tab's polling: an immediate load on entry, then the
  // cadence; the timer stops on unmount (the tab may close at any time). The
  // cadence is part of the dependency set, so entering or leaving a scan
  // rebuilds the loop — and its immediate first load is what fetches the
  // just-published roster the moment a scan settles.
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive.current) void load();
    };
    run();
    timer = setInterval(run, scanning ? scanPollMs : pollMs);
    return () => {
      alive.current = false;
      // Invalidate the reads this loop started: the cadence change that
      // rebuilds this effect (60 s ↔ 2 s) also re-sets `alive` to true on the
      // way back in, so a slow read from the OLD loop could otherwise still
      // pass the liveness test and overwrite the new loop's fresher answer.
      generation.current += 1;
      if (timer !== null) clearInterval(timer);
      // NOTE: the header is deliberately NOT cleared here. This cleanup also
      // runs on every cadence rebuild (entering/leaving a scan), where the tab
      // is still mounted — clearing wiped the header's raccoon cluster until
      // the next successful GET, which the unmount-only effect below avoids.
    };
  }, [load, onReportStatus, scanning, pollMs, scanPollMs]);

  // Unmount ONLY: drop this tab's freshness from the header (the quota/api tabs
  // own their own clusters, so nothing else should show this one's). Split from
  // the polling effect because that one's cleanup also fires on a cadence
  // rebuild. Held in a ref so the effect can have an empty dependency list and
  // therefore run its cleanup exactly once, on unmount.
  const onReportStatusRef = useRef(onReportStatus);
  onReportStatusRef.current = onReportStatus;
  useEffect(() => () => {
    if (onReportStatusRef.current !== undefined) onReportStatusRef.current(null);
  }, []);

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
    // The route answers the moment it has issued a scan — the walk runs behind
    // it — so this is an ordinary short request, not a five-minute one. Its
    // body IS the state a GET would return: the scan URL to render, and
    // `loginStatus:"scanning"`, which is what switches the poll loop to the
    // fast cadence.
    //
    // Nothing here polls. The loop above already does, and it stops being fast
    // the instant the route stops saying "scanning" — the old 150 × 2 s local
    // loop had no such brake, so it kept polling for the full five minutes
    // after a scan that settled in ten seconds.
    try {
      const body = (await postJson(RACCOON_PATH, { action: "login" })) as RaccoonState | null;
      if (alive.current) {
        if (body?.ok === true) {
          setState(body);
        } else {
          // Through the shared `format`, not a hand-rolled `.replace`: the
          // dictionary's `{error}` slot is one interpolation rule, owned by
          // `format.ts` (the refusal table's `auth.failed` uses the same one).
          setLoginNote(body?.error ?? format(tt("raccoon.error"), { error: "login did not finish" }));
        }
      }
    } catch (why) {
      if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setLoginBusy(false);
    }
  }, [tt]);

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
  // the curation and the registration status in one round-trip. WHICH ids to
  // send is the card's decision (a toggle is applied against the whole
  // roster); this only performs the write.
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
          ? {
              ...current,
              enabledModelIds: ids,
              providerRegistered: body?.providerRegistered === true,
              ...(typeof body?.providerError === "string" ? { providerError: body.providerError } : {})
            }
          : current));
        setModelsNote(tt("raccoon.modelsSaved"));
      }
    } catch (why) {
      if (alive.current) setModelsNote(format(tt("raccoon.modelsError"), { error: why instanceof Error ? why.message : String(why) }));
    } finally {
      if (alive.current) setIdsBusy(false);
    }
  }, [tt]);

  return h(RaccoonCard, {
    state,
    tt,
    loginBusy,
    loginNote,
    modelsNote,
    idsBusy,
    onLogin: () => void startLogin(),
    onLogout: () => void logout(),
    onSwitch: (enabled: boolean) => void toggle(enabled),
    onIds: (ids: string[]) => void saveIds(ids)
  });
}
