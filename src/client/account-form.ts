/**
 * The setup form shown when no account is configured.
 *
 * This is the whole point of the account route: the user types a username
 * and a password once, and the Host signs in, stores the account in the
 * DSH credentials, and renews the token from then on. No `.env` editing,
 * no restart, and the password is never sent anywhere but this Host.
 *
 * `bare` strips the inner card and title: the account section card that
 * embeds this form (when a token already works) supplies both itself.
 *
 * Hook-based, so the Node render suite does not mount this form; its
 * secret-free halves are covered via `ProviderStatus` and the route tests.
 */
import { ACCOUNT_PATH, SENSENOVA_SIGNUP_URL } from "./const.ts";
import { format } from "./format.ts";
import { postJson } from "./http.ts";
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { REFUSAL_TEXT } from "./snapshot.ts";
import { S } from "./styles.ts";
import type { AuthData } from "./wire.ts";

export function AccountForm({ auth, onDone, tt, bare, snapshotAt }: {
  auth?: AuthData | null;
  onDone?: () => void;
  tt: Tt;
  bare?: boolean;
  /** Epoch millis of the last snapshot the parent read; 0 until one lands. */
  snapshotAt?: number;
}): unknown {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The user must be able to see what they actually typed: a browser
  // autofill or an IME full-width character looks identical to a real
  // password behind the dots, and every failed guess burns a lockout
  // attempt on the platform.
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The platform's own words for a classified refusal, shown beneath the
  // canned line: the canned text translates, the prose carries the lockout
  // policy and anything else the platform wanted to say.
  const [formDetail, setFormDetail] = useState<string | null>(null);
  // `saved` means a sign-in was stored. It is NOT a generic "the request
  // worked" flag — forgetting the account is a different outcome with a
  // different sentence, and reusing this one made the "clear the saved
  // account" button announce "saved and signed in, reading quota…".
  const [saved, setSaved] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  // When the LAST submit/forget outcome was produced. The outcome notes
  // ("已保存并登录，正在读取额度…" / "已清除账号…") are transient claims:
  // they must land once a snapshot AFTER them arrives. Without a marker,
  // `saved`/`forgotten` never reset and the in-progress sentence hangs
  // forever even though the quota is already on screen above it.
  const outcomeAt = useRef(0);
  // Epoch millis until which the platform asked us not to retry. While
  // this is in the future the submit button stays disabled, because a
  // retry inside the window is what extends a lockout.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // One ticking clock drives the countdown; it stops when the wait ends.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  // The outcome notes land when a snapshot AFTER them arrives. The parent
  // (PanelPage) stamps every successful snapshot read; once one is newer
  // than the last submit/forget, the "正在读取额度…"/"已清除账号…" claim has
  // been superseded by real data and must not hang around.
  useEffect(() => {
    if (typeof snapshotAt === "number" && snapshotAt > outcomeAt.current) {
      setSaved(false);
      setForgotten(false);
    }
  }, [snapshotAt]);

  const cooling = now < cooldownUntil;
  const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 60_000));

  const setCooldown = useCallback((ms: number) => {
    setCooldownUntil(Date.now() + ms);
    setNow(Date.now());
  }, []);

  const submit = useCallback(async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    // Refuse to fire inside the platform's own wait window.
    if (cooling) return;
    if (username.trim() === "" || password === "") {
      setFormError(tt("auth.empty"));
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, { username: username.trim(), password });
      if (body && body.ok === true) {
        // Clear the password from component state the moment it is no
        // longer needed: it lives on in the Host's credentials, not here.
        setPassword("");
        setSaved(true);
        // A fresh sign-in supersedes any earlier "account cleared" note.
        setForgotten(false);
        // Stamp the outcome: the "正在读取额度…" note stays until a snapshot
        // newer than this lands (the parent's `snapshotAt` clears it).
        outcomeAt.current = Date.now();
        onDone?.();
        return;
      }
      const code = body?.code;
      // The Host's own backoff is authoritative: retrying inside it is what
      // turns a bad password into a locked account, so surface the wait
      // instead of a plain refusal.
      const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
      if (waitMs !== null && waitMs > 0) {
        setCooldown(waitMs);
        // The line comes from the table, not from a second copy of the two
        // codes: `account_locked` and `rate_limited` are already classified
        // there, and a code this branch compares inline could be renamed in
        // `codes.ts` while the table kept working — the check below reads the
        // table, so a literal here would have drifted out of its sight.
        setFormError(tt(REFUSAL_TEXT[typeof code === "string" ? code : ""] ?? "auth.rateLimited"));
        return;
      }
      // Only say "wrong password" when the platform said so. Every other
      // refusal gets its own line, and anything unrecognised shows the
      // platform's own words rather than a guess. A missing `code` is by
      // definition not a known refusal — the old `REFUSAL_TEXT[undefined]`
      // read missed and fell through to the same lines the guard takes now.
      if (typeof code === "string" && typeof REFUSAL_TEXT[code] === "string") {
        // The dictionary key is the decision, never the wire code: comparing a
        // code inline was a third home for the taxonomy, outside these tables
        // and outside every check that pins them (F2b now fails on any inline
        // comparison). A key carrying a `{token}` is interpolated (`auth.failed`
        // wants the platform's own reason); any other refusal is a plain line.
        const refusalKey = REFUSAL_TEXT[code];
        setFormError(refusalKey.includes("{")
          ? format(tt(refusalKey), { reason: body?.error ?? "" })
          : tt(refusalKey));
        setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
        return;
      }
      setFormError(body?.error ?? tt("auth.network"));
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [username, password, onDone, tt, cooling, setCooldown]);

  const forget = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const body = await postJson(ACCOUNT_PATH, { forget: true });
      if (body?.ok !== true) {
        setFormError(body?.error ?? tt("auth.network"));
        return;
      }
      // Not `setSaved`: that flag means a sign-in was stored, and its
      // sentence claims one. Clearing the account is its own outcome.
      setForgotten(true);
      setSaved(false);
      setUsername("");
      setPassword("");
      // Stamp the outcome: the "已清除账号" note stays until a snapshot
      // newer than this lands.
      outcomeAt.current = Date.now();
      onDone?.();
    } catch {
      setFormError(tt("auth.network"));
    } finally {
      setBusy(false);
    }
  }, [onDone, tt]);

  return h(
    "div",
    { style: bare ? {} : { ...S.card, maxWidth: 420 } },
    // `bare` drops the inner card and title: the caller (the account
    // section card) already supplies both.
    bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")),
    // The official entry, visible in BOTH states: no account yet → the
    // sign-up page; account present → quota management / API keys.
    // Shown in both standalone and bare embed forms.
    h("a", {
      href: SENSENOVA_SIGNUP_URL,
      target: "_blank",
      rel: "noreferrer",
      // Inline: the shared `styles.ts` is under a concurrent rewrite
      // (roster/model-row restyle), so this one-off link skin lives here.
      style: S.externalLink
    }, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")),
    h(
      "form",
      { onSubmit: submit },
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.username")),
        h("input", {
          style: S.input,
          value: username,
          autoComplete: "username",
          placeholder: tt("auth.placeholderUser"),
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setUsername(event.target.value)
        })
      ),
      h(
        "label",
        { style: S.field },
        h("span", { style: S.fieldLabel }, tt("auth.password")),
        h(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", {
            style: { ...S.input, flex: 1 },
            type: showPassword ? "text" : "password",
            value: password,
            autoComplete: "current-password",
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value)
          }),
          h(
            "button",
            {
              type: "button",
              style: { ...S.button, flex: "none" },
              disabled: busy,
              onClick: () => setShowPassword((shown) => !shown)
            },
            showPassword ? tt("auth.hide") : tt("auth.show")
          )
        )
      ),
      h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
        h(
          "button",
          {
            type: "submit",
            style: { ...S.primary, ...(busy || cooling ? S.primaryBusy : {}) },
            disabled: busy || cooling
          },
          busy ? tt("auth.submitting") : tt("auth.submit")
        ),
        auth?.hasAccount
          ? h(
              "button",
              { type: "button", style: S.button, disabled: busy, onClick: forget },
              tt("auth.forget")
            )
          : null
      ),
      // Two different outcomes, two different sentences: "the account was
      // cleared" must never read as "saved and signed in".
      forgotten
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.forgotten"))
        : saved
          ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("auth.working"))
          : null,
      formError ? h("p", { style: S.formError, role: "alert" }, formError) : null,
      formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null,
      // The wait is stated with the platform's own number, so the reason
      // the button is greyed out is never a mystery.
      cooling
        ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-warn-primary)" } },
            format(tt("auth.retryAfter"), { minutes: coolingMinutes }))
        : null,
      // One note carries the persistence facts. The auto-recovery variant
      // REPLACES the saved line when armed: the saved line's "需重新输入一次"
      // would contradict an automatic re-login. When not armed, the saved
      // line already covers the manual path — a second "自动恢复：未开启" line
      // would be jargon that says the same thing twice.
      h("p", { style: S.formNote },
        auth?.ephemeral === true
          ? tt("auth.ephemeral")
          : auth?.autoRecoverArmed === true
            ? tt("auth.autoRecoverOn")
            : tt("auth.saved"))
    )
  );
}
