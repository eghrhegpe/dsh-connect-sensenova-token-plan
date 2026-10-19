/**
 * The DSH credentials service, resolved on every use — one source for the three
 * stores that reach it (`token-store`, `api-key-store`, `raccoon-store`).
 *
 * The wiring hands each store either the service itself (tests) or a resolver
 * FUNCTION (production, where the service is looked up per use because it may
 * register AFTER this plugin mounts). That 4-line idiom was copied verbatim into
 * all three stores, and a copy in this domain has already drifted once in
 * silence (`fakes.mjs`'s fixture, where `v !== ""` and `v.length > 0` had
 * quietly diverged), so it lives here instead.
 *
 * `null` is a real ANSWER, not a failure: it means "this Host has no credentials
 * service". Every caller replies to it the same way — fall back to its own
 * in-memory vault, and report `ephemeral: true`, because a credential that does
 * not survive a restart must be said out loud rather than silently accepted as
 * saved. That is the whole reason both helpers exist next to each other.
 *
 * @module dsh-connect-sensenova-token-plan/credentials-service
 */

/**
 * Resolve the credentials service, or `null` when this Host has none.
 *
 * The return type is deliberately unannotated: the callers narrow the result
 * themselves (`typeof service.set === "function"`), and the service's shape is
 * the Host's, not this plugin's — naming it here would be a second, quietly
 * drifting copy of someone else's interface.
 * @param {unknown} credentials - the `ctx.credentials` service, a resolver, or `null`.
 * @returns {any} the service, or `null`.
 */
export function resolveCredentialsService(credentials: unknown) {
  const value = typeof credentials === "function" ? credentials() : credentials;
  return value ?? null;
}

/**
 * True while nothing written through the store would survive a restart.
 *
 * Read by the panel-facing state of all three stores (`ephemeral`), which is why
 * it is defined against the same resolver: a store that answered `false` here
 * while reading through the in-memory vault would tell the user their credential
 * was saved when the next restart will not find it.
 * @param {unknown} credentials - the `ctx.credentials` service, a resolver, or `null`.
 * @returns {boolean}
 */
export function isEphemeral(credentials: unknown): boolean {
  return resolveCredentialsService(credentials) === null;
}
