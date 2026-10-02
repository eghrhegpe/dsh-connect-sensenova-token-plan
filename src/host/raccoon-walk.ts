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
 * @param options.fetcher - the gateway fetcher (for tests to inject a fake).
 * @param options.saveCredential - called with `{ accessToken, refreshToken, expiresAtMs?, nickname? }`; MUST persist to the credentials service. Errors become a `failed` event.
 * @param options.invalidateCache - called on successful login to drop reads taken under the previous credential.
 * @param options.onSettled - called once at the START of each scan cycle (after
 *   the QR code is generated, before the poll loop begins), regardless of the
 *   outcome. Kept for callers that want to reset per-scan UI state; the read
 *   model's `login` view reads the walk's own state (`takeEvent` / `liveScan`),
 *   not this hook, so the route registers it as a no-op.
 * @param options.onLoggedIn - called AFTER the credential was persisted and the
 *   read cache cleared, with the outcome already `logged_in`. The caller's
 *   provider-registration side effect lives here. Its failures are swallowed:
 *   the credential is already in place, so a publish miss is a degraded-but-
 *   logged-in state, never a login failure.
 * @returns {{ view: RaccoonWalkView, issueScan: () => Promise<void> }}
 */
export function createRaccoonWalk(options: {
  fetcher: (code: string) => Promise<RaccoonQrPollResult>;
  saveCredential: (credential: { accessToken: string; refreshToken: string; expiresAtMs?: number; nickname?: string }) => Promise<void>;
  invalidateCache: () => void;
  onSettled: () => void;
  onLoggedIn?: () => void;
}): { view: RaccoonWalkView; issueScan: () => Promise<void> } {
  let scan: { code: string; url: string } | null = null;
  /** `null` while idle; a promise while the walk runs. Cleared in finally. */
  let walk: Promise<void> | null = null;
  let status: LoginStatus | null = null;
  let error: string | null = null;

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
    options.onSettled();

    const deadline = Date.now() + RACCOON_LOGIN_TIMEOUT_MS;
    let canceled = false;
    let settled: SettledScan | null = null;

    try {
      try {
        while (Date.now() < deadline) {
          let poll;
          try {
            poll = await options.fetcher(code);
          } catch {
            // Transient poll error: keep waiting, don't fail the walk.
            poll = { status: RACCOON_QR_STATUS.PENDING };
          }
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
          await new Promise((resolve) => setTimeout(resolve, RACCOON_QR_POLL_INTERVAL_MS));
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
        status = canceled ? LOGIN_STATUS.canceled : LOGIN_STATUS.timeout;
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
        // about it through the event channel, so the reason rides there
        // (sanitized — the store's message may quote the document).
        status = LOGIN_STATUS.failed;
        error = String(saveError instanceof Error ? saveError.message : saveError);
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
    walk = runScan()
      .catch(() => {
        // An unexpected path (should not happen) — treat as a failed scan.
        status = LOGIN_STATUS.failed;
        error = error ?? null;
      });
    // Fire-and-forget: the route answers immediately with the scan URL.
    void walk;
  }

  return { view, issueScan };
}
