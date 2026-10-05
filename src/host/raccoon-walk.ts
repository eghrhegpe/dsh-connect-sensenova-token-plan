/**
 * The Raccoon QR login walk — a single-responsibility module for the
 * in-flight scan lifecycle.
 *
 * Why this lives outside `routes.ts`: the scan code must stay stable while a
 * walk is waiting, otherwise two walks each own a different code and the GET
 * can only ever report one — a scan that looks permanently stuck, with no
 * error anywhere to explain it (PITFALLS §31, test T2). The walk also needs
 * access to the cache (to clear it on login/logout) and to the publish layer
 * (to register the provider on successful login), so burying it inside a
 * route handler meant either leaking those seams through the handler or
 * duplicating them.
 *
 * What this module owns (and nothing else):
 *   - issuing a scan code
 *   - polling the gateway until settle or timeout
 *   - persisting the credential pair (delegates to callers)
 *   - clearing the read cache on settle
 *   - firing the logged-in side-effect hook (`onLoggedIn`) after the
 *     credential landed
 *   - emitting the settled outcome as an event
 *
 * Callers register the business-step callbacks (save, invalidate, onLoggedIn)
 * ONCE at construction; the walk drives them at the right point of the
 * lifecycle. `onLoggedIn` is where provider registration happens — the login
 * branch used to fake it by assigning `invalidateCache` onto the returned
 * object, a write nobody reads (the walk's own `invalidateCache` is the one
 * captured at construction). The walk module holds only the transient screen —
 * the scan code, the in-flight gate, the event that the GET returns.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-walk
 */
import { RACCOON_QR_STATUS, RACCOON_QR_POLL_INTERVAL_MS, RACCOON_LOGIN_TIMEOUT_MS, generateRaccoonQrCode, raccoonQrLoginUrl } from "./raccoon.ts";
import { errMsg, redactSecrets } from "./util.ts";
import type { RaccoonQrPollResult } from "./raccoon.ts";

/**
 * A settled scan carrying the credential pair.
 *
 * `pollRaccoonQrLogin` only reports `success` WITH a non-empty `accessToken`
 * (a tokenless success stays `pending`), so the pair is guaranteed here — but
 * `RaccoonQrPollResult` must keep `accessToken` optional for the other
 * statuses. Narrowing once at the boundary is what lets `saveCredential`
 * receive a `string` without a runtime re-check of a guarantee the parser
 * already made (docs/IMPROVEMENTS.md §8).
 */
type SettledScan = RaccoonQrPollResult & { accessToken: string; refreshToken: string };

/** The terminal outcomes the tab reads. */
export const LOGIN_STATUS = Object.freeze({
  scanning: "scanning",
  logged_in: "logged_in",
  timeout: "timeout",
  canceled: "canceled",
  failed: "failed"
}) satisfies Record<string, string>;
/** Values the tab's `loginStatus` field can hold. */
export type LoginStatus = typeof LOGIN_STATUS[keyof typeof LOGIN_STATUS];

/**
 * A snapshot of the walk's transient state, as the route's GET reads it.
 *
 * No mutations happen here — the walk owns the state, the GET only asks.
 */
export interface RaccoonWalkView {
  /** Whether a walk has been initiated and not yet settled (covers scanning → settled). */
  isInFlight(): boolean;
  /** The scan issued most recently, or `null` before `issueScan()` is called. */
  liveScan(): { code: string; url: string } | null;
  /**
   * Take the settled outcome ONCE.
   *
   * Terminal events (`logged_in` / `timeout` / `canceled` / `failed`) are
   * consumed here — a later poll cannot re-announce a two-minute-old timeout.
   * `scanning` is not consumed (it is the live in-flight state).
   * @returns {{ status: LoginStatus | null, error: string | null }}
   */
  takeEvent(): { status: LoginStatus | null; error: string | null };
}

/**
 * Build the walk manager.
 *
 * @param options
 * @param {(code: string) => Promise<RaccoonQrPollResult>} options.fetcher - the gateway fetcher (for tests to inject a fake).
 * @param {(credential: { accessToken: string; refreshToken: string; expiresAtMs?: number; nickname?: string }) => Promise<void>} options.saveCredential - called with `{ accessToken, refreshToken, expiresAtMs?, nickname? }`; MUST persist to the credentials service. Errors become a `failed` event.
 * @param {() => void} options.invalidateCache - called on successful login to drop reads taken under the previous credential.
 * @param {() => void} options.onSettled - called once at the START of each scan cycle (after
 *   the QR code is generated, before the poll loop begins), regardless of the
 *   outcome. OPTIONAL: it exists for callers that want to reset per-scan UI
 *   state, and the read model does not use it — `login` reads the walk's own
 *   state (`takeEvent` / `liveScan`) — so the route registers nothing and a
 *   caller with no per-scan UI has nothing to say.
 * @param {() => void} options.onLoggedIn - called AFTER the credential was persisted and the
 *   read cache cleared, with the outcome already `logged_in`. The caller's
 *   provider-registration side effect lives here. Its failures are swallowed:
 *   the credential is already in place, so a publish miss is a degraded-but-
 *   logged-in state, never a login failure.
 * @returns {{ view: RaccoonWalkView, issueScan: () => Promise<void>, stop: () => void }}
 */
export function createRaccoonWalk(options: {
  fetcher: (code: string) => Promise<RaccoonQrPollResult>;
  saveCredential: (credential: { accessToken: string; refreshToken: string; expiresAtMs?: number; nickname?: string }) => Promise<void>;
  invalidateCache: () => void;
  onSettled?: () => void;
  onLoggedIn?: () => void;
}): { view: RaccoonWalkView; issueScan: () => Promise<void>; stop: () => void } {
  let scan: { code: string; url: string } | null = null;
  /** `null` while idle; a promise while the walk runs. Cleared in finally. */
  let walk: Promise<void> | null = null;
  let status: LoginStatus | null = null;
  let error: string | null = null;
  /**
   * Set by `stop()` when the plugin is letting go of this walk (route
   * teardown). It is the ONE flag that can end a poll loop early, and it is
   * checked in three places, all of them load-bearing — see `stoppedAt` below.
   */
  let stopRequested = false;
  /**
   * Wakes the poll loop's inter-poll sleep. A bare `stopRequested` check would
   * still leave the loop parked for up to a full poll interval after teardown,
   * because the sleep is not interrupted by anything else; holding the resolver
   * lets `stop()` cut it short, so a cancelled walk stops in microseconds
   * rather than seconds. `null` while not sleeping.
   */
  let wakePoll: (() => void) | null = null;

  /**
   * Whether this walk must not touch the credentials service any more.
   *
   * Read at each of the three points where the walk would otherwise still have
   * an effect after teardown: before each poll, after a poll returns (a
   * gateway call in flight when `stop()` lands still resolves), and before the
   * credential write. The last one is the reason this flag exists at all — a
   * walk that settled in the same tick the Host began unloading would otherwise
   * persist a fresh credential pair into a service the plugin no longer owns,
   * and keep knocking on the gateway until its own deadline.
   */
  const stoppedAt = () => stopRequested;

  /** The poll interval, as an interruptible sleep. */
  const sleepOnePoll = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        wakePoll = null;
        resolve();
      };
      const timer = setTimeout(done, RACCOON_QR_POLL_INTERVAL_MS);
      wakePoll = () => {
        clearTimeout(timer);
        done();
      };
    });

  const view: RaccoonWalkView = {
    isInFlight: () => walk !== null,
    liveScan: () => scan,
    takeEvent: () => {
      // A terminal status is an EVENT, not a state: hand it over and clear it,
      // or every later poll re-announces a two-minute-old timeout. `scanning`
      // is the live state of an in-flight walk, so it stays.
      const took = { status, error };
      if (status !== null && status !== LOGIN_STATUS.scanning) {
        status = null;
        error = null;
      }
      return took;
    }
  };

  /**
   * Run one scan cycle. Errors from save or settle do NOT propagate — they
   * become a `failed` event so the tab can surface a reason.
   */
  async function runScan() {
    const code = generateRaccoonQrCode();
    const url = raccoonQrLoginUrl(code);
    scan = { code, url };
    status = LOGIN_STATUS.scanning;
    error = null;
    options.onSettled?.();

    const deadline = Date.now() + RACCOON_LOGIN_TIMEOUT_MS;
    let canceled = false;
    let settled: SettledScan | null = null;

    try {
      try {
        while (Date.now() < deadline && !stoppedAt()) {
          let poll;
          try {
            poll = await options.fetcher(code);
          } catch {
            // Transient poll error: keep waiting, don't fail the walk.
            poll = { status: RACCOON_QR_STATUS.PENDING };
          }
          // A poll already in flight when `stop()` landed still resolves. Its
          // result is discarded: the walk is over, and acting on a `success`
          // here is exactly the credential write `stop()` exists to prevent.
          if (stoppedAt()) break;
          if (poll.status === RACCOON_QR_STATUS.SUCCESS) {
            // The parser guarantees a non-empty pair on `success` (a tokenless
            // success is reported as `pending`, never here) — this narrowing
            // states that contract instead of re-checking it at runtime.
            settled = poll as SettledScan;
            break;
          }
          if (poll.status === RACCOON_QR_STATUS.CANCELED) {
            canceled = true;
            break;
          }
          await sleepOnePoll();
        }
      } finally {
        // The scan is over; the poll loop's own cleanup lands here. The GATE is
        // deliberately NOT reopened here: `saveCredential` still runs below,
        // and during that window `isInFlight()` must stay true — otherwise a
        // second login would issue a second scan and the two walks race to
        // write the shared scan/status/error (PITFALLS §31; test T2 covers the
        // poll window only). The gate reopens two levels down, after save.
      }

      if (settled === null) {
        // A stop is reported as `canceled`, not `timeout`: the gateway was
        // never given the chance to be late, and telling the tab it timed out
        // would be a lie it has no way to correct.
        status = canceled || stoppedAt() ? LOGIN_STATUS.canceled : LOGIN_STATUS.timeout;
        return;
      }

      // The last gate before the only write this walk performs. `settled` is
      // non-null here, so without this the walk could land a credential the
      // Host stopped owning — the poll loop can finish in the same tick the
      // teardown starts.
      if (stoppedAt()) {
        status = LOGIN_STATUS.canceled;
        return;
      }

      try {
        await options.saveCredential({
          accessToken: settled.accessToken,
          refreshToken: settled.refreshToken,
          ...(settled.expiresAtMs !== undefined ? { expiresAtMs: settled.expiresAtMs } : {}),
          ...(settled.nickname !== undefined && settled.nickname !== "" ? { nickname: settled.nickname } : {})
        });
        options.invalidateCache();
        status = LOGIN_STATUS.logged_in;
        // The logged-in side effect (provider publish etc.), fired after the
        // credential landed and the outcome was set. Its failure must NOT flip
        // the result: the pair is already persisted, so a publish miss is a
        // degraded-but-logged-in state, never a failed login.
        try {
          options.onLoggedIn?.();
        } catch {
          // no-op — best-effort; the next switch toggle or mount seed retries.
        }
      } catch (saveError) {
        // The scan worked but the credential did not land: the tab can only hear
        // about it through the event channel, so the reason rides there.
        //
        // REDACTED, because that channel is the one place in this module whose
        // output is guaranteed to reach a browser: `takeEvent()` feeds
        // `raccoon-status.ts`'s `loginError`, which rides the GET response
        // straight into the panel. A store or credentials-provider message can
        // quote the record it was handed, and the record is the credential pair
        // (AGENTS.md red line 1: credentials never reach logs, traces, or
        // responses). `redactSecrets` is the same helper `draw.ts` puts between
        // an error and its response — the comment here used to CLAIM this was
        // sanitized while passing a bare `String(message)` underneath, and
        // nothing between here and the DOM would have caught it.
        status = LOGIN_STATUS.failed;
        error = redactSecrets(errMsg(saveError));
      }
    } finally {
      // Both exits land here: whatever the outcome (settled / save / publish),
      // the gate must reopen even when the walk threw — otherwise every later
      // login would be told "a walk is already waiting" forever. Reopening
      // AFTER save keeps a second login from racing this walk's credential
      // write (the poll-loop cleanup alone reopened it too early, so a login
      // clicked during the save window used to issue a second scan).
      walk = null;
    }
  }

  async function issueScan() {
    // A scan issued after `stop()` is refused rather than started: the walk
    // belongs to a route that is being unregistered, so there is no longer a
    // tab on the other end of it.
    if (stoppedAt()) {
      status = LOGIN_STATUS.canceled;
      return;
    }
    walk = runScan()
      .catch(() => {
        // An unexpected path (should not happen) — treat as a failed scan.
        status = LOGIN_STATUS.failed;
        error = error ?? null;
      });
    // Fire-and-forget: the route answers immediately with the scan URL.
    void walk;
  }

  /**
   * End the walk now, without waiting out the poll loop.
   *
   * Called by the route's `off()` callback, so a plugin that unloads mid-scan
   * stops writing credentials and stops calling the gateway. Idempotent, and
   * safe to call when no walk is running — which is every teardown but the one
   * that races a live scan.
   */
  function stop() {
    stopRequested = true;
    wakePoll?.();
  }

  return { view, issueScan, stop };
}
