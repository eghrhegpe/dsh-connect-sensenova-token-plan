/**
 * The curated model allow-list UI: the hook-free row list and the hook-based
 * picker around it.
 */
import { MODELS_PATH } from "./const.ts";
import { errorText, format, tokenSize } from "./format.ts";
import { postJsonOrThrow } from "./http.ts";
import { ModelRow } from "./model-row.ts";
import { bulkModelsIn, modelIsOn, toggleModelIn } from "./models.ts";
import { dictKey, h, useCallback, useEffect, useMemo, useRef, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { LlmData, ModelData } from "./wire.ts";

/**
 * The single empty roster every "the Host sent no list" fallback resolves to.
 *
 * It is a CONSTANT on purpose. A literal `[]` written at the use site is a
 * fresh object on every render, which silently breaks every `useMemo` /
 * `useCallback` that lists it as a dependency: the memo recomputes on each
 * poll, so a search keystroke re-renders the whole catalogue. Freezing one
 * instance here keeps `models` referentially stable across renders even when
 * `llm` is null - which is exactly what the memo below claims it is.
 */
const NO_MODELS: ModelData[] = [];
const NO_IDS: string[] = [];

/**
 * The model picker's row list - hook-free, so the Node render suite
 * drives the very rows the browser draws.
 *
 * This component owns only what is SPECIFIC to the Token Plan catalogue; the
 * two-line row itself is drawn by {@link ModelRow}, shared with the Raccoon
 * roster (see that module for why the skeleton has one definition). What is
 * specific here: the allow-list decides `on` (`modelIsOn` — an id absent from
 * the list is OFF), the pseudo rate is always rendered `×N` because the Host
 * matched it through the operator's own config, and the parameter line quotes
 * window, output ceiling, and the thinking levels DSH's selector will really
 * offer for THIS model.
 *
 * A provider-wide constant (the default effort) never repeats per row - it is
 * stated once in the header, because a fact that never varies between rows is
 * noise, not information. The rows come only from the Host's roster, so a
 * curated id that no longer exists can never become a checkbox: curation is a
 * filter over the catalogue, never a catalogue of its own. A default ("text
 * only") earns no badge, and a figure the catalogue does not declare draws no
 * segment - the list quotes facts, never guesses.
 */
export function ModelRoster({ models, enabledIds, busy, tt, onToggle }: {
  models: ModelData[];
  enabledIds: unknown;
  busy: boolean | undefined;
  tt: Tt;
  onToggle?: (id: string) => void;
}): unknown {
  const list = Array.isArray(models) ? models : [];
  return h(
    "ul",
    { style: S.modelList, role: "list" },
    list.map((model) => {
      const id = String(model?.id ?? "");
      const label = String(model?.name ?? id);
      const on = modelIsOn(enabledIds, id);
      const ctx = typeof model?.contextWindow === "number" && model.contextWindow > 0
        ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) })
        : null;
      const out = typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0
        ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) })
        : null;
      // The selectable ladder, projected Host-side with pi-ai's own filter over
      // the descriptor map - so this list IS what the DSH selector offers.
      // Localized per level (关闭/低/中/高/极高/最高), joined compactly.
      const levels = Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0
        ? format(tt("llm.metaLevels"), {
          levels: model.thinkingLevels.map((level) => tt(dictKey("llm.level", level))).join("/")
        })
        : null;
      const meta = [ctx, out, levels].filter(Boolean).join(" · ");
      const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
      return h(ModelRow, {
        key: id,
        id,
        label,
        on,
        busy,
        // The pseudo rate rides directly after the name like WorkBuddy's
        // `(0.29x)`: the Host matched it through the same operator config
        // that labels the trend chart, so badge and chart cannot diverge.
        // `×0` stays `×0` here — the operator's pseudo figure is exactly what
        // configured it, and the tooltip below says so.
        rateText: rate === null ? null : `×${rate}`,
        rateTitle: tt("llm.rosterRateTitle"),
        // A badge marks a NOTABLE state: image input is the exception worth
        // quoting, and `quota exhausted` says why a ticked row still will
        // not show up in the DSH picker (the buildDescriptors parity rule).
        badges: [
          model?.vision === true ? h("span", { key: "vision", style: S.modelBadge }, tt("llm.rosterVision")) : null,
          model?.quotaExhausted === true
            ? h("span", { key: "exhausted", style: { ...S.modelBadge, color: "var(--dsw-alias-state-error-primary)" } }, tt("llm.rosterExhausted"))
            : null
        ],
        meta,
        onToggle
      });
    })
  );
}

/**
 * The curated model allow-list: which of this key's models get pushed to
 * DSH's model list.
 *
 * Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
 * free half it draws - `ModelRoster` and the counts - instead of this
 * state machine. The edit is local until saved: the picker holds a draft
 * of the allow-list, the "unsaved" state is DERIVED by comparing it with
 * the Host's current value, and the "saved" state is the same comparison
 * after a poll echoes the write. Both therefore cannot lie: a save that
 * never reached the Host keeps showing the edits, and an edit that ends
 * up identical to the Host's value shows neither button.
 */
export function ModelPicker({ llm, onDone, tt }: {
  llm?: LlmData | null;
  onDone?: () => void;
  tt: Tt;
}): unknown {
  const models = Array.isArray(llm?.models) ? llm.models : NO_MODELS;
  const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : NO_IDS;
  const [ids, setIds] = useState<string[]>(() => hostIds.slice());
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Whether the USER has edited the draft since the last Host sync. The
  // auto-sync must not clobber an in-flight edit; an untouched picker must
  // FOLLOW the Host. The old guard compared the CURRENT ids against the NEW
  // hostKey — unequal the instant the Host moved — so the picker never synced,
  // and a Host-side change showed as "unsaved" with a Save button that would
  // POST the stale list over the Host's value.
  const touchedRef = useRef(false);

  // Serialising the allow-lists is the picker's only per-render cost that
  // scales with the catalogue, so it is memoised on the arrays themselves:
  // a keystroke in the search box must not re-stringify every saved id.
  const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
  const idsKey = useMemo(() => JSON.stringify(ids), [ids]);
  const dirty = idsKey !== hostKey;
  const justSaved = savedKey !== null && savedKey === hostKey;

  // Follow the Host while the picker is untouched, so a catalogue refresh
  // reaches the list and a save from another client clears the draft.
  // `touchedRef` (not `dirty`) is the guard: an edit in flight must survive,
  // while a Host-side change on an untouched picker must land.
  useEffect(() => {
    if (!touchedRef.current) setIds(hostIds);
    // Deliberately keyed on `hostKey` alone. `hostIds` is a fresh array on
    // every poll, so listing it would re-run this effect constantly and
    // overwrite an edit in flight; `hostKey` is the stable signal that the
    // Host's value actually moved. (An `eslint-disable` sat here until it was
    // removed: this repo has no eslint config and no eslint dependency, so the
    // comment suppressed a rule nothing ran while implying a lint gate exists.)
  }, [hostKey]);

  // The "已保存" notice ends when the picker is edited again (or the
  // Host's value moves on). It must NOT end on the poll that echoes our
  // own write — that echo is exactly when the notice is supposed to show;
  // clearing it on every hostKey change made the success line unreachable.
  useEffect(() => {
    if (dirty === true) setSavedKey(null);
  }, [dirty]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const posted = JSON.stringify(ids);
    try {
      await postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids });
      // The user's intent is now on the Host: the picker may follow the Host
      // again from here on. Matches hostKey as soon as the poll after onDone()
      // echoes it.
      touchedRef.current = false;
      setSavedKey(posted);
      onDone?.();
    } catch (error) {
      setNotice(format(tt("llm.rosterError"), { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
  }, [busy, ids, onDone, tt]);

  const needle = query.trim().toLowerCase();
  // `models` holds its identity between renders - it comes straight off the
  // snapshot object, and the "no list" case resolves to the frozen NO_MODELS
  // rather than a fresh `[]`. So memoising on it plus the search text gives
  // `bulk` dependency values stable by REFERENCE; the earlier
  // `JSON.stringify(...)` deps existed only to fake that stability.
  const visible = useMemo(() => models.filter((model) => {
    if (needle === "") return true;
    return String(model?.id ?? "").toLowerCase().includes(needle)
      || String(model?.name ?? "").toLowerCase().includes(needle);
  }), [needle, models]);
  const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;

  /** Apply "tick all" / "untick all" to the VISIBLE rows only. */
  const bulk = useCallback((allOn: boolean) => {
    // Strings, never the `{id, name, vision}` rows: the allow-list is
    // compared against a roster of ids, and an object roster would filter to
    // nothing — "tick all" would have posted the hide-all sentinel.
    const roster = models.map((model) => String(model?.id ?? ""));
    const targets = visible.map((model) => String(model?.id ?? ""));
    touchedRef.current = true;
    setIds(bulkModelsIn(ids, roster, targets, allOn));
    setNotice(null);
  }, [models, visible, ids]);

  return h(
    "div",
    { style: { marginBottom: 14 } },
    // Title and rule were sharing one line with the mechanism sentence, which
    // read as a caption bolted to a heading: a title, then a paragraph, then a
    // value, all in one breath. The rule is still the tail of the title's own
    // sentence and stays; the mechanism paragraph drops to the footnote at the
    // bottom of the block (the same stop `raccoon-roster.ts` uses for its
    // fallback note), where it explains without competing with the heading.
    // The provider-wide thinking default rides here too: it is one constant for
    // every row, so the roster says it ONCE instead of repeating it seven times.
    // The dash is the title's own tail and only appears when a value follows
    // it — a lone `推送到 DSH 的模型 —` trailed off into nothing when the Host
    // declared no thinking default.
    h("p", { style: { margin: "0 0 10px" } },
      h("span", { style: S.sectionTitle }, tt("llm.roster")),
      typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== ""
        ? h("span", { style: { ...S.muted, fontSize: 12 } },
          ` — ${format(tt("llm.rosterThinkingDefault"), { level: tt(dictKey("llm.level", llm.thinkingDefault)) })}`)
        : null),
    models.length === 0
      ? h("p", { style: S.empty }, tt("llm.rosterEmpty"))
      : h(
          "div",
          null,
          h(
            "div",
            { style: S.rosterTools },
            h("input", {
              type: "search",
              style: { ...S.input, flex: "1 1 200px", width: "auto" },
              value: query,
              placeholder: tt("llm.rosterSearchPlaceholder"),
              "aria-label": tt("llm.rosterSearchPlaceholder"),
              disabled: busy,
              onChange: (event: { target: { value: string } }) => setQuery(event.target.value)
            }),
            // The count LEADS the right-hand cluster - state, then actions -
            // and the bulk buttons share the search box's 32px height, so the
            // row reads as one grouped control instead of four loose ones.
            h("span", {
              style: S.rosterCount,
              title: format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })
            }, format(tt("llm.rosterCount"), { selected: tickedCount, total: visible.length })),
            h("button", {
              type: "button",
              style: S.rosterBulk,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(true)
            }, tt("llm.rosterAll")),
            h("button", {
              type: "button",
              style: S.rosterBulk,
              disabled: busy === true || visible.length === 0,
              onClick: () => bulk(false)
            }, tt("llm.rosterNone"))
          ),
          visible.length === 0
            ? h("p", { style: S.empty }, tt("llm.rosterNoMatch"))
            : h("div", { style: S.modelPanel }, h(ModelRoster, {
                models: visible,
                enabledIds: ids,
                busy,
                tt,
                // One row is toggled against the WHOLE roster, not the
                // filtered view, so an edit survives a later change of the
                // search box.
                onToggle: (id: string) => {
                  touchedRef.current = true;
                  setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
                  setNotice(null);
                }
              })),
          dirty
            ? h(
                "div",
                { style: S.rosterFoot },
                h("button", {
                  type: "button",
                  style: S.primary,
                  disabled: busy === true,
                  onClick: () => void save()
                }, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")),
                h("button", {
                  type: "button",
                  style: S.button,
                  disabled: busy === true,
                  onClick: () => {
                    // Discard is an explicit return to the Host's value; the
                    // picker may follow the Host again from here on.
                    touchedRef.current = false;
                    setIds(hostIds);
                    setNotice(null);
                  }
                }, tt("llm.rosterDiscard")),
                h("span", { style: { ...S.muted, fontSize: 12 } }, tt("llm.rosterUnsaved"))
              )
            : justSaved
              ? h("p", { style: { ...S.formNote, color: "var(--dsw-alias-state-success-primary)" }, role: "status" }, tt("llm.rosterSaved"))
              : null,
          // The mechanism sentence, at the quietest layer: what ticking a box
          // does and how a newly-catalogued model starts out. It explains the
          // list without holding the heading hostage.
          h("p", { style: { ...S.trendLegend, marginTop: 10 } }, tt("llm.rosterHint")),
          notice !== null ? h("p", { style: S.formError, role: "alert" }, notice) : null
        )
  );
}
