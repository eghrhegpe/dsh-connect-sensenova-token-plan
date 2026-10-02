/**
 * Login-trace persistence.
 *
 * Every sign-in attempt (success included) leaves one sanitized trace file in
 * `$DSH_HOME/logs/`: a "browser works but the panel does not" report is only
 * debuggable by diffing a working trace against a failing one. The sanitizing
 * itself happens in `sensenova-auth.ts` — no password, token, cookie, or
 * authorization code ever reaches this module — so the only concern here is
 * I/O failures, which must never break the login response.
 * @module dsh-connect-sensenova-token-plan/trace
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { str } from "./util.ts";

/**
 * Where login traces are written. `$DSH_HOME/logs/` keeps them next to the
 * other Host logs; `DSH_HOME` defaults to `~/.dsh`.
 */
export function traceDir() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "logs");
}

/**
 * Persist one login trace to disk, or fail silently.
 *
 * Written on EVERY attempt (success included): a "browser works but the panel
 * does not" report is only debuggable by diffing a working trace against a
 * failing one. The trace itself is already sanitized in sensenova-auth — no
 * password, token, cookie, or authorization code ever reaches this file — so
 * the only concerns here are I/O failures, which must never break the login
 * response.
 * @param {object[]|undefined} trace - the sanitized hop list from the auth module.
 * @param {string} outcome - "ok" or the error code, for the filename.
 * @returns {Promise<string|null>} the file path, or null when not written.
 */
export async function writeLoginTrace(trace: unknown[] | undefined, outcome: string) {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  try {
    const dir = traceDir();
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `sensenova-login-${stamp}-${str(outcome, "unknown").replace(/[^a-z_]/gi, "")}.json`);
    await fs.writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Keep the directory from growing forever: the last 20 traces are plenty.
    const files = (await fs.readdir(dir)).filter((name) => name.startsWith("sensenova-login-")).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 20))) {
      await fs.rm(join(dir, stale), { force: true }).catch(() => {});
    }
    return file;
  } catch {
    return null;
  }
}
