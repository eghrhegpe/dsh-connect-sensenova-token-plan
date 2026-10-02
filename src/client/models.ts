/**
 * The model allow-list algebra, shared by the picker and the roster rows.
 *
 * It carries BOTH dialects of the `enabledModelIds` field: the Token Plan
 * side (`[]` = no filter, the hide-all sentinel for "nothing") and the
 * Raccoon gateway side (`null` = no filter, `[]` for "nothing"). Callers pick
 * a dialect by calling its primitive — never by re-deriving the rule inline.
 */

/**
 * The allow-list spelling for "nothing is offered".
 *
 * An empty list already means "no filter", so "the filter matched
 * nothing" needs its own spelling: one entry naming an id no real model
 * can carry. The Host carries the SAME literal (`llm-models.ts`
 * `HIDE_ALL_MODELS`) — the browser bundle cannot import that module, so
 * `test/provider.test.mjs` compares the two and a rename on either side
 * goes red instead of silently un-curating every model.
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/** The model ids a roster advertises, junk entries dropped. */
export function rosterIds(roster: unknown): string[] {
  return (Array.isArray(roster) ? roster : []).filter(
    (model): model is string => typeof model === "string" && model !== ""
  );
}

/**
 * Whether one model id is offered by an allow-list.
 *
 * Mirrors the Host's `filterByEnabled`: an empty list offers everything,
 * a non-empty one is a strict allow-list, and `HIDE_ALL_MODELS` alone
 * offers nothing.
 */
export function modelIsOn(enabledIds: unknown, id: string): boolean {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  return list.length === 0 ? true : list.includes(id);
}

/**
 * The allow-list that offers exactly the ids in `on`.
 *
 * Every mutation funnels through here, so the two extreme spellings are
 * emitted consistently: an empty list (nothing curated, every model
 * offered) and `HIDE_ALL_MODELS` alone (nothing offered). No caller can
 * post a list the Host would read differently than the picker shows.
 */
export function allowListFor(on: Set<string>, roster: unknown): string[] {
  const all = rosterIds(roster);
  const kept = all.filter((model) => on.has(model));
  if (kept.length === 0) return [HIDE_ALL_MODELS];
  if (kept.length === all.length) return [];
  return kept;
}

/**
 * The next allow-list after ticking or unticking one model.
 *
 * The result is computed against the WHOLE roster, not the current
 * list: the saved value is a complete allow-list rather than a diff, so
 * a curated catalogue stays curated when the catalogue later grows —
 * new models start unticked instead of slipping into DSH on their own.
 */
export function toggleModelIn(enabledIds: unknown, roster: unknown, id: string): string[] {
  const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
  if (on.has(id)) on.delete(id);
  else on.add(id);
  return allowListFor(on, roster);
}

/** The allow-list for a bulk "tick all" / "untick all". */
export function setAllModelsIn(roster: unknown, allOn: boolean): string[] {
  return allowListFor(new Set(allOn ? rosterIds(roster) : []), roster);
}

/**
 * The next allow-list after a bulk "tick all" / "untick all" over one set
 * of targets, computed against the WHOLE roster.
 *
 * The targets are the ids the reader is looking at right now (a filtered
 * view); the rows outside them keep whatever the Host already offers, so
 * the result stays a complete allow-list rather than a diff. Both id lists
 * must be STRINGS — `rosterIds` drops anything that is not one, so a roster
 * of `{id}` rows would filter to nothing and the whole call would collapse
 * to the hide-all sentinel no matter which way the button was pressed.
 */
export function bulkModelsIn(enabledIds: unknown, roster: unknown, targets: unknown, allOn: boolean): string[] {
  const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
  for (const id of targets as Iterable<string>) if (allOn) on.add(id as string);
  else on.delete(id as string);
  return allowListFor(on, roster);
}

// --- the Raccoon dialect -----------------------------------------------------
//
// The SECOND upstream spells the same field the other way round, and that is a
// documented fact of its route, not an accident (see `raccoon-roster.ts` and
// `docs/ROADMAP.md` §6.1): `null`/absent means "the whole roster pushes", while
// an empty ARRAY means "nothing does". The two dialects live here, side by
// side, for the reason the whole module exists: "what counts as on" and "what
// to post after a tick" are ONE fact, and any caller that re-derives them
// inline gets one of the two directions wrong. It did: the card hand-rolled
// `ids.filter((id) => id !== toggled)`, so a model could be switched OFF and
// never back ON (the un-tick path was the only one implemented).

/**
 * Whether one model id is offered by the RACCOON curation.
 *
 * Mirrors the gateway route's reading: an array is a strict allow-list
 * (`[]` offers nothing), anything else — `null`, absent — offers everything.
 */
export function raccoonModelIsOn(enabledIds: unknown, id: string): boolean {
  return Array.isArray(enabledIds) ? enabledIds.includes(id) : true;
}

/**
 * The next curation after ticking or unticking one model, in that dialect.
 *
 * Deliberately the mirror of {@link toggleModelIn} minus the hide-all
 * sentinel: an empty array already spells "nothing pushes" here, so a second
 * spelling would be a second way to say it.
 *
 * The result is a COMPLETE, roster-ordered list rather than a diff, and an
 * all-on toggle deliberately does NOT collapse back to `null`: `null` keeps
 * its one meaning ("the panel never curated"), so a curation the reader made
 * stays made — a model the gateway adds later starts unticked instead of
 * slipping into DSH on its own, which is the same policy the Token Plan side
 * spells with `allowListFor`.
 */
export function toggleRaccoonModelIn(enabledIds: unknown, roster: unknown, id: string): string[] {
  const all = rosterIds(roster);
  const on = new Set(all.filter((model) => raccoonModelIsOn(enabledIds, model)));
  if (on.has(id)) on.delete(id);
  else on.add(id);
  return all.filter((model) => on.has(model));
}