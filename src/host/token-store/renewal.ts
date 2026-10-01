/**
 * Block 3 of the token-store split: renewal through the stored refresh token.
 *
 * `renewWithRefresh` calls the grant block's `store` (compare-and-set write),
 * so it receives `store` as an injected callback — keeping this module free of
 * any `grant.ts` import (no circular dependency). The function body is
 * **verbatim**; the behavior baseline stays green.
 *
 * @module dsh-connect-sensenova-token-plan/token-store/renewal
 */

import { CODE } from "../codes.ts";
import { pluginError } from "../util.ts";

/**
 * Renew with the stored refresh token.
 *
 * Goes through the grant block's `store`, which names the superseded access
 * token so a concurrent rotation is detected instead of silently overwritten.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
 */
export async function renewWithRefresh(wiring, _state, stored, store) {
  const { auth } = wiring;
  if (stored?.refreshToken === undefined || stored.refreshToken === "") {
    throw pluginError(CODE.NO_REFRESH_TOKEN, "stored grant has no refresh token");
  }
  const result = await auth.refresh(stored.refreshToken);
  // Name the token this renewal supersedes, so a concurrent rotation is
  // detected instead of silently overwritten.
  return store(result.accessToken, result.refreshToken, result.expiresIn, stored.accessToken);
}
