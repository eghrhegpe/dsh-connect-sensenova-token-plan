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
import { format } from "./format.ts";
import { postJson, postJsonOrThrow } from "./http.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { RaccoonCard } from "./raccoon-card.ts";
import type { RaccoonState } from "./raccoon-card.ts";

/** The cadence the tab polls at while open (balance + roster drift slowly). */
const RACCOON_POLL_MS = 60_000;
/**
 * The cadence while a scan is waiting.
 *
 * The gateway's own client polls every 2 s, so a confirmed scan must be
 * noticed within a couple of seconds of it happening. It costs nothing when no
 * scan is in flight (the loop drops back to the slow cadence the moment the
 * route stops saying `scanning`), and it is bounded by the SERVER's deadline —
 * the tab holds no timer of its own that could outlive the walk.
 */
const RACCOON_SCAN_POLL_MS = 2_000;

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
  // `loading`/`error` are lifted to the header via onReportStatus (see the
  // props comment above); these local states exist only so the setters called
  // in load() remain valid, but their values are never rendered here.
  const [_loading, setLoading] = useState(true);
  const [_error, setError] = useState<string | null>(null);
  // The login click's own round-trip: the route issues the scan and answers
  // straight away, so this is SHORT. The wait the user actually experiences is
  // the scan, which the route reports as `loginStatus:"scanning"`.
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [idsBusy, setIdsBusy] = useState(false);
  const alive = useRef(true);

  // Stamp the header's refresh channel with the time of the last successful
  // GET. A failed read keeps the previous timestamp (the data is only stale,
  // not gone) but still forwards the error so the header can surface it.
  const report = useCallback((updatedAt: number, err: string | null) => {
    if (onReportStatus !== undefined && alive.current) {
      onReportStatus({ updatedAt, error: err, onRefresh: () => void load() });
    }
  }, [onReportStatus]);

  const load = useCallback(async () => {
    const at = Date.now();
    try {
      const response = await fetch(RACCOON_PATH, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok || !alive.current) return;
      const body = (await response.json().catch(() => null)) as RaccoonState | null;
      if (!alive.current) return;
      if (body === null || body.ok === false) {
        setError(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
        // A failed read does not reset the timestamp we already reported.
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
      setError(null);
      report(at, null);
    } catch {
      if (alive.current) setError("unable to reach the Host");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [report, tt]);

  // A scan is waiting on the phone. The ROUTE owns that fact (and the walk's
  // deadline), so the tab has no timer of its own to leak: it simply polls
  // faster while the route says so, and drops back the moment it stops.
  const scanning = state?.loginStatus === "scanning";

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
    timer = setInterval(run, scanning ? RACCOON_SCAN_POLL_MS : RACCOON_POLL_MS);
    return () => {
      alive.current = false;
      if (timer !== null) clearInterval(timer);
      // The tab is closing: drop its freshness from the header (the quota/api
      // tabs own their own clusters, so nothing else should show this one's).
      if (onReportStatus !== undefined) onReportStatus(null);
    };
  }, [load, onReportStatus, scanning]);

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
          setLoginNote(body?.error ?? tt("raccoon.error").replace("{error}", "login did not finish"));
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
