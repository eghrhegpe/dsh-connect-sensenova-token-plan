/**
 * The panel's rendered output, checked against the code the browser loads.
 *
 * The decision tests assert WHICH view renders; nothing asserted WHAT that
 * view says. The known blind spot was a numeric swap — a `WindowRow` that
 * renders `limit/used` instead of `used/limit`, or drops the remaining
 * figure, passed the whole suite. These checks feed arithmetic the reader can
 * verify by hand (12345 of 60000 is 20.575%) into the panel's REAL rendering
 * components and inspect what would reach the screen.
 *
 * There is no DOM and no React here: `panel-render.js` lifts the components
 * out of client.js and evaluates them with a recording `h`, so function
 * components stay uncalled until a check expands them — the tree a check sees
 * is the tree React would receive.
 */
import { render, styles as S, texts, findElement, findAll } from "./panel-render.js";
import { h, surface } from "./client-surface.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

/** Identity dictionary: assertions are about WHICH key applies, not its text. */
const tt = (key) => key;

/** Render a lifted component to its element tree (function components uncalled). */
const treeOf = (component, props) => component(props);

/** Collect the text a rendered component would put on screen. */
const rendered = (component, props) => texts(treeOf(component, props));

/** The panel's progress-bar element, wherever it sits in the tree. */
const bar = (tree) => findElement(tree, (props) => props["aria-valuenow"] !== undefined);

// === A. the quota card's arithmetic is the one the reader can verify ======
// 12345 of 60000 is 20.575%. Any swap of used/limit/remaining turns these
// figures into different numbers, so this block is the anti-mirror for the
// exact bug the decision tests could not see.
{
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
    tt
  });
  const meta = texts(tree).join("\n");
  check("the used figure is the USED count against the limit",
    meta.includes("pool.used 12,345 / 60,000"), meta);
  check("the headline is the REMAINING percentage",
    meta.includes("79.4%"), meta);
  check("the used percentage is not shown as the headline", !meta.includes("20.6%"), meta);
  check("the raw remaining count is not on the card — the percentage implies it",
    !meta.includes("47,655"), meta);

  const fill = bar(tree);
  check("the bar reports the same percentage to assistive tech",
    Number(fill?.props["aria-valuenow"]) === 20.6, String(fill?.props["aria-valuenow"]));
  const inner = findElement(fill, (props) => typeof props.style?.width === "string");
  check("the bar's width is the same fraction the text shows",
    inner?.props.style.width === "20.575%", String(inner?.props.style.width));
  check("the reset time is rendered when present", meta.includes("pool.reset"), meta);
}

// === B. a window without a reset time stays quiet about resets ============
{
  const out = rendered(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    tt
  });
  check("no reset time means no reset line", !out.includes("pool.reset"), out.join("\n"));
}

// === C. the bar's tone escalates as the window fills ======================
// The thresholds live in the client (70 warn / 90 error); a check hard-coding
// a colour would pass a tone swap. The values come from the lifted S instead.
{
  const fillFor = (used) => {
    const fill = bar(treeOf(render.QuotaCard, {
      label: "l", window: { limit: 60000, used, remaining: 60000 - used, resetAt: null }, tt
    }));
    return findElement(fill, (p) => typeof p.style?.width === "string")?.props.style;
  };
  check("an ordinary window uses the brand fill",
    fillFor(30000).background === S.barFill.background, JSON.stringify(fillFor(30000)));
  check("past 70% the bar turns to the warn fill",
    fillFor(42000).background === S.barFillWarn.background, JSON.stringify(fillFor(42000)));
  check("past 90% the bar turns to the error fill",
    fillFor(54000).background === S.barFillError.background, JSON.stringify(fillFor(54000)));
}

// === D. an empty limit is unknown, never a fake percentage ================
{
  const tree = treeOf(render.QuotaCard, {
    label: "l", window: { limit: 0, used: 0, remaining: 0, resetAt: null }, tt
  });
  check("a zero limit renders as an em dash, not 0.0%", texts(tree).includes("—") && !texts(tree).includes("%"), texts(tree).join("\n"));
  check("the bar's reported value stays a number",
    bar(tree)?.props["aria-valuenow"] !== undefined && Number(bar(tree)?.props["aria-valuenow"]) === 0,
    String(bar(tree)?.props["aria-valuenow"]));
}

// === E. the trend table lists rows in order, with the credited amounts ====
{
  const out = rendered(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  const alpha = out.indexOf("Alpha");
  check("the table carries both models", alpha !== -1 && out.includes("Beta"), out.join("\n"));
  check("row order follows the data", alpha !== -1 && alpha < out.indexOf("42.5") && out.indexOf("42.5") < out.indexOf("Beta"),
    out.join("\n"));
  check("a zero-credit row still renders", out.includes("0"), out.join("\n"));
  check("the table is a table, not the empty note", !out.includes("trend.none"), out.join("\n"));
}

// === E2. the trend card visualises which model consumed the most ========
// The bare table earned a card and a per-row bar: each bar is relative to
// the LARGEST consumer, so the top model fills the track and the rest
// shrink proportionally — that is the "who is burning credits" answer.
{
  const tree = treeOf(render.TrendTable, {
    trend: { models: [{ model: "Alpha", credits: 42.5 }, { model: "Beta", credits: 0 }] },
    tt
  });
  check("the trend rows sit inside a card like the quota cards",
    tree.props?.style?.background === S.card.background && tree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(tree.props?.style ?? {}));
  const bars = findAll(tree, (props) => props["aria-valuenow"] !== undefined);
  check("each model row carries its own bar", bars.length === 2, `found ${bars.length}`);
  const widths = bars.map((bar) => findElement(bar, (p) => typeof p.style?.width === "string")?.props.style?.width);
  check("the biggest consumer fills the track", widths.includes("100%"), JSON.stringify(widths));
  check("a zero-credit model gets an empty track", widths.includes("0%"), JSON.stringify(widths));
  check("the bars report the same fractions to assistive tech",
    bars[0]?.props["aria-valuenow"] === 100 && bars[1]?.props["aria-valuenow"] === 0,
    bars.map((bar) => bar.props["aria-valuenow"]).join(", "));
  check("the absolute amount still sits beside the model name",
    texts(tree).includes("42.5") && texts(tree).includes("0"), texts(tree).join("\n"));
}

// === F. an empty trend says so instead of rendering an empty table ========
{
  const out = rendered(render.TrendTable, { trend: { models: [] }, tt });
  check("an empty trend shows the empty note", out.includes("trend.none"), out.join("\n"));
  const none = rendered(render.TrendTable, { trend: null, tt });
  check("a missing trend shows the empty note too", none.includes("trend.none"), none.join("\n"));
  const emptyTree = treeOf(render.TrendTable, { trend: { models: [] }, tt });
  check("the empty note sits inside a card too",
    emptyTree.props?.style?.background === S.card.background, JSON.stringify(emptyTree.props?.style ?? {}));
}

// === G. the pool card assembles its own sections ==========================
{
  const pool = {
    name: "通用池", poolType: "default",
    modelIds: ["Model-A", "Model-B"],
    lockedModels: ["Model-C"],
    window5h: { limit: 60000, used: 1, remaining: 59999, resetAt: null },
    window7d: { limit: 600000, used: 2, remaining: 599998, resetAt: null },
    grantBalance: 0
  };
  const out = rendered(render.PoolCard, { pool, tt });
  check("the pool's name is rendered", out.includes("通用池"), out.join("\n"));
  check("a default pool is labelled as such", out.includes("pool.default"), out.join("\n"));
  check("both quota windows are present",
    out.includes("pool.window5h") && out.includes("pool.window7d"), out.join("\n"));
  check("the fold carries the details summary", out.includes("pool.details"), out.join("\n"));
  check("every callable model is listed (inside the fold)",
    out.includes("Model-A") && out.includes("Model-B"), out.join("\n"));
  check("locked models are summarised, not listed", out.includes("pool.locked") && !out.includes("Model-C"),
    out.join("\n"));
  check("no grant text when the balance is zero", !out.includes("pool.grant"), out.join("\n"));

  const dedicated = rendered(render.PoolCard, { pool: { ...pool, poolType: "dedicated" }, tt });
  check("a dedicated pool is labelled as such", dedicated.includes("pool.dedicated"), dedicated.join("\n"));

  const granted = rendered(render.PoolCard, { pool: { ...pool, grantBalance: 500 }, tt });
  check("a grant balance is rendered when present", granted.includes("pool.grant"), granted.join("\n"));

  // `callableModels` (the /v1/models truth) outranks `modelIds` (the plan's
  // list): a model the plan covers but this key cannot call is NOT callable.
  const scoped = rendered(render.PoolCard, {
    pool: { ...pool, callableModels: ["Model-A"] }, tt
  });
  check("the callable list wins over the plan list",
    scoped.includes("Model-A") && !scoped.includes("Model-B"), scoped.join("\n"));
}

// === G2. sections are collapsible card headers, expanded by default ======
// The two content sections live behind a workbuddy-style card header: a
// full-width button (title + rotating chevron) that tucks the body away.
// The header is hook-free — `open`/`onToggle` arrive as props — so the
// toggle is exercised here; `PanelPage` starts both sections expanded.
{
  const children = ["inner"];
  const openTree = treeOf(render.SectionCard, {
    title: "section.pools", open: true, onToggle: () => {}, tt, children
  });
  check("the section sits in a card like the quota cards",
    openTree.props?.style?.background === S.card.background && openTree.props?.style?.borderRadius === S.card.borderRadius,
    JSON.stringify(openTree.props?.style ?? {}));
  const head = findElement(openTree, (props) => props["aria-expanded"] !== undefined);
  check("the section header is a real button", head?.type === "button", String(head?.type));
  check("an open section reports aria-expanded=true", head?.props["aria-expanded"] === true,
    String(head?.props["aria-expanded"]));
  check("the header announces the collapse action",
    head?.props["aria-label"] === "section.collapse: section.pools", String(head?.props["aria-label"]));
  check("the header hands the click to the toggle", typeof head?.props.onClick === "function", "");
  check("an open section renders its body", texts(openTree).includes("inner"), texts(openTree).join("\n"));
  check("an open body is not hidden",
    findElement(openTree, (props) => props.hidden !== undefined)?.props.hidden === false, "");
  const chev = findElement(openTree, (props) => typeof props.viewBox === "string");
  check("the header carries a chevron", chev !== null, "");
  check("the chevron flips when the section is open",
    chev?.props.style?.transform === "rotate(180deg)", String(chev?.props.style?.transform));

  const closedTree = treeOf(render.SectionCard, {
    title: "section.trend", open: false, onToggle: () => {}, tt, children
  });
  const closedHead = findElement(closedTree, (props) => props["aria-expanded"] !== undefined);
  check("a closed section reports aria-expanded=false", closedHead?.props["aria-expanded"] === false,
    String(closedHead?.props["aria-expanded"]));
  check("the header announces the expand action",
    closedHead?.props["aria-label"] === "section.expand: section.trend", String(closedHead?.props["aria-label"]));
  check("a closed section hides its body", !texts(closedTree).includes("inner"), texts(closedTree).join("\n"));
  check("the body stays mounted but hidden when closed",
    findElement(closedTree, (props) => props.hidden !== undefined)?.props.hidden === true, "");
  const closedChev = findElement(closedTree, (props) => typeof props.viewBox === "string");
  check("the chevron points down when the section is closed",
    closedChev?.props.style?.transform === undefined, String(closedChev?.props.style?.transform));
}

// === G3. the step-three provider status is secret-free and stateful ======
// ProviderStatus (key card) says ONLY where the key came from; the
// registration states live in ProviderRegStatus (provider card) since the
// panel grew one card per concern. These render with the REAL zh
// dictionary: the identity `tt` returns the key itself, which carries no
// `{placeholder}` to expand, so composition (the counts, the id, the
// source) could not be checked through it.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("no llm block renders nothing",
    rendered(render.ProviderStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderStatus, { llm: "x", tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: null, tt }).length === 0
      && rendered(render.ProviderRegStatus, { llm: "x", tt }).length === 0);

  const off = rendered(render.ProviderStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-token-plan" },
    tt: ttZh
  });
  check("no key asks for one", off.some((line) => line.includes(zh["llm.noKey"])), off.join("\n"));
  check("the key card does NOT speak for the provider card",
    !off.some((line) => line.includes("未向 DSH 注册")), off.join("\n"));

  const regOff = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false,
      llmAvailable: false, providerRegistered: false, providerId: "sensenova-token-plan" },
    tt: ttZh
  });
  check("the opt-in being off is stated",
    regOff.some((line) => line.includes("未向 DSH 注册") && line.includes("开关")), regOff.join("\n"));
  check("the provider id is shown",
    regOff.some((line) => line.includes("sensenova-token-plan")), regOff.join("\n"));

  const registered = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "credentials", ephemeral: false, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "sensenova-token-plan",
      modelCount: 3, visionCount: 1,
      // A defensive field the Host never sends: it must never reach the screen.
      value: "sk-secret-value" },
    tt: ttZh
  });
  const regOn = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", ephemeral: false, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "sensenova-token-plan",
      modelCount: 3, visionCount: 1, value: "sk-secret-value" },
    tt: ttZh
  });
  check("a stored key reports the credentials source",
    registered.some((line) => line.includes(zh["llm.src.credentials"])), registered.join("\n"));
  check("the registered line carries both counts and the id",
    regOn.some((line) => line.includes("3") && line.includes("1")
      && line.includes("sensenova-token-plan")), regOn.join("\n"));
  check("the key value itself never renders",
    !registered.some((line) => line.includes("sk-secret-value"))
      && !regOn.some((line) => line.includes("sk-secret-value")), regOn.join("\n"));
  check("ephemeral is quiet when a credentials service exists",
    !registered.some((line) => line.includes(zh["llm.ephemeral"])));

  const fromEnv = rendered(render.ProviderStatus, {
    llm: { hasApiKey: true, keySource: "env", ephemeral: true, registerProvider: true,
      llmAvailable: true, providerRegistered: true, providerId: "p", modelCount: 0, visionCount: 0 },
    tt: ttZh
  });
  check("an environment key reports the environment source",
    fromEnv.some((line) => line.includes(zh["llm.src.env"])), fromEnv.join("\n"));
  check("an ephemeral host says so",
    fromEnv.some((line) => line.includes(zh["llm.ephemeral"])), fromEnv.join("\n"));

  const noService = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  check("enabled without an llm service says so",
    noService.some((line) => line.includes(zh["llm.noService"])), noService.join("\n"));

  const failed = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a failed registration shows the error line",
    failed.some((line) => line.includes("DUPLICATE_ADAPTER")), failed.join("\n"));

  // The switch is ticked, no error, service present, but registration has
  // not landed: the line must NOT claim the switch is off — that is the
  // same visibility lie the account editor used to tell after a "forget".
  const pending = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: true, providerRegistered: false, providerId: "p" },
    tt: ttZh
  });
  // Match a placeholder-free substring of the pending line, not the raw
  // dictionary string (which still carries the unfilled `{id}`).
  check("a ticked switch without a landed registration says pending, not off",
    pending.some((line) => line.includes("开关已开但注册尚未生效"))
      && !pending.some((line) => line.includes("未向 DSH 注册")), pending.join("\n"));

  // A specific failure outranks a capability gap: both llmAvailable false
  // and a providerError present must show the error, not the capability line.
  const both = rendered(render.ProviderRegStatus, {
    llm: { hasApiKey: true, keySource: "credentials", registerProvider: true,
      llmAvailable: false, providerRegistered: false, providerId: "p", providerError: "DUPLICATE_ADAPTER" },
    tt: ttZh
  });
  check("a specific error outranks the no-service line",
    both.some((line) => line.includes("DUPLICATE_ADAPTER"))
      && !both.some((line) => line.includes(zh["llm.noService"])), both.join("\n"));
}

// === G4. the model roster: which rows exist, and which are ticked ==========
// The picker's rows are the single source of truth for "what could this key be
// pushed": a curated id that no longer exists must never become a checkbox, and
// each checkbox state must be exactly what the Host's allow-list says. The row
// is hook-free, so the render suite drives the real one.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const roster = [
    { id: "nova-flash-lite", name: "Nova Flash Lite", vision: false },
    { id: "nova-vl", name: "Nova VL", vision: true },
    { id: "nova-pro", name: "Nova Pro", vision: false }
  ];
  const treeOfRoster = (enabledIds, extra = {}) =>
    treeOf(render.ModelRoster, { models: roster, enabledIds, tt: ttZh, ...extra });
  const boxes = (tree) => findAll(tree, (props) => props.type === "checkbox").map((el) => el.props);

  const allOn = treeOfRoster([]);
  const allOnTexts = texts(allOn);
  check("every catalogue entry becomes one tickable row", boxes(allOn).length === 3,
    `found ${boxes(allOn).length} checkboxes`);
  check("row order follows the catalogue, not the allow-list",
    (() => {
      const flat = texts(allOn).join(" ");
      const a = flat.indexOf("Nova Flash Lite");
      const b = flat.indexOf("Nova VL");
      const c = flat.indexOf("Nova Pro");
      return a !== -1 && b !== -1 && c !== -1 && a < b && b < c;
    })(), texts(allOn).join("\n"));
  check("an empty allow-list ticks every model",
    JSON.stringify(boxes(allOn).map((props) => props.checked)) === JSON.stringify([true, true, true]),
    JSON.stringify(boxes(allOn).map((props) => props.checked)));

  const partial = treeOfRoster(["nova-pro", "nova-vl"]);
  check("a curated allow-list ticks exactly those models, in row order",
    JSON.stringify(boxes(partial).map((props) => props.checked)) === JSON.stringify([false, true, true]),
    JSON.stringify(boxes(partial).map((props) => props.checked)));

  const none = treeOfRoster([surface.helpers.HIDE_ALL_MODELS]);
  check("the hide-all sentinel unticks every model",
    JSON.stringify(boxes(none).map((props) => props.checked)) === JSON.stringify([false, false, false]),
    JSON.stringify(boxes(none).map((props) => props.checked)));

  const visionLines = texts(allOn).filter((line) => line === zh["llm.rosterVision"]);
  check("one vision model earns one vision badge", visionLines.length === 1, String(visionLines.length));
  check("a text-only model earns NO badge — the default state is not notable",
    findAll(allOn, (props) => props.style?.borderRadius === 999).length === 1,
    String(findAll(allOn, (props) => props.style?.borderRadius === 999).length));
  check("an unticked row keeps its vision badge",
    texts(none).filter((line) => line === zh["llm.rosterVision"]).length === 1);

  const busy = treeOfRoster(["nova-vl"], { busy: true });
  check("a save in flight disables every checkbox",
    boxes(busy).every((props) => props.disabled === true),
    JSON.stringify(boxes(busy).map((props) => props.disabled)));
  check("an idle roster leaves the checkboxes live",
    boxes(allOn).every((props) => props.disabled !== true));

  // Each box hands its edit back to the picker; without the callback a row is
  // display-only and the allow-list could not be changed one model at a time.
  const withToggle = treeOfRoster(["nova-vl"], { onToggle: (id) => id });
  const toggles = boxes(withToggle).map((props) => props.onChange);
  check("every checkbox carries its edit handler",
    toggles.length === 3 && toggles.every((fn) => typeof fn === "function"),
    JSON.stringify(toggles.map((fn) => typeof fn)));
  check("a roster without a handler stays display-only",
    boxes(allOn).every((props) => props.onChange === undefined));

  check("a checkbox announces the model name to assistive tech",
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])) === JSON.stringify(["Nova Flash Lite", "Nova VL", "Nova Pro"]),
    JSON.stringify(boxes(allOn).map((props) => props["aria-label"])));

  check("a missing display name falls back to the id",
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).includes("nova-bare"),
    texts(treeOf(render.ModelRoster, { models: [{ id: "nova-bare" }], enabledIds: [], tt })).join("\n"));

  check("a curated id that is no longer in the catalogue draws no row",
    boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length === 3,
    String(boxes(treeOf(render.ModelRoster, { models: roster, enabledIds: ["ghost-model"], tt })).length));

  // The WorkBuddy-shape additions: the parameter line and the pseudo rate.
  // The 1048576 → "1M" reading is exactly the `1049k` placeholder bug the old
  // decimal rounding drew, so it stays pinned here and in tokenSize below.
  const rich = [{
    id: "deepseek-v4-flash", name: "deepseek-v4-flash", vision: false, available: false, quotaExhausted: true,
    contextWindow: 1048576, maxOutputLength: 65536, multiplier: 10,
    // Proven-only levels: the 2026-09-30 probe recorded 200 on
    // low/medium/xhigh for this model (frozen baseline) — the roster
    // quotes exactly what the panel would let the user pick.
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"]
  }];
  const richTree = treeOf(render.ModelRoster, { models: rich, enabledIds: [], tt: ttZh });
  const richText = texts(richTree).join("\n");
  check("1048576 tokens reads as 1M — never the decimal 1049k",
    richText.includes("1M 上下文") && !richText.includes("1049k"), richText);
  check("the platform-declared output ceiling lands in the parameter line",
    richText.includes("最大输出 64K"), richText);
  check("the row quotes THIS model's selectable levels, localized like the picker",
    richText.includes("思考 关闭/低/中/高/极高"), richText);
  check("the provider-wide default never repeats per row (it lives in the header)",
    !richText.includes("默认思考强度") && !richText.includes(zh["llm.rosterThinkingDefault"]), richText);
  check("the pseudo multiplier labels the row ×N", richText.includes("×10"), richText);
  check("a quota-exhausted row names why it cannot answer",
    richText.includes(zh["llm.rosterExhausted"]), richText);
  check("a row without declared figures draws no parameter line",
    texts(allOn).every((line) => !line.includes("上下文")), texts(allOn).join("\n"));
  const tokenSize = surface.helpers.tokenSize;
  check("tokenSize keeps decimal and binary figures at home",
    tokenSize(1048576) === "1M" && tokenSize(262144) === "256K" &&
    tokenSize(128000) === "128K" && tokenSize(65536) === "64K" &&
    tokenSize(0) === "" && tokenSize("junk") === "",
    [tokenSize(1048576), tokenSize(262144), tokenSize(128000), tokenSize(65536), tokenSize(0)].join("/"));

  check("an empty catalogue draws no rows at all",
    boxes(treeOf(render.ModelRoster, { models: [], enabledIds: [], tt })).length === 0);

  check("a junk models value reads as an empty catalogue",
    boxes(treeOf(render.ModelRoster, { models: "nope", enabledIds: [], tt })).length === 0);
}

// === G5. the exhaustion notice explains WHY models vanish and WHEN back ===
// When a pool hits zero the host drops its models from the picker; without this
// line the reader sees models disappear with no cause or recovery expectation.
// The component is hook-free and reads only the snapshot's pools, so the render
// suite drives the real one. It must stay silent when nothing is exhausted, and
// must surface the EARLIEST reset among the exhausted windows.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;

  const clean = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("a fully-stocked plan renders no exhaustion notice", clean.length === 0, clean.join("\n"));

  const exhausted = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
      window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
  ] }, tt: ttZh });
  check("an exhausted pool surfaces the notice",
    exhausted.some((line) => line.includes("部分积分池已耗尽") && line.includes("暂不可选")), exhausted.join("\n"));
  check("the notice carries the earliest reset time",
    exhausted.some((line) => line.includes(when(1800003600))), exhausted.join("\n"));
  check("the notice is marked as a status role for assistive tech",
    treeOf(render.PoolExhaustionNotice, { pools: { pools: [
      { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } }
    ] }, tt: ttZh })?.props?.role === "status");

  // Two exhausted windows across pools: the EARLIEST reset wins, not the latest.
  const two = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 100, remaining: 0, resetAt: 1800007200 }, window7d: { limit: 100, used: 1, remaining: 99, resetAt: null } },
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null }, window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the earliest of multiple exhausted resets is shown",
    two.some((line) => line.includes(when(1800003600))) && !two.some((line) => line.includes(when(1800007200))),
    two.join("\n"));
}

// === G6. a zeroed quota window is labelled "已耗尽", not just 0 ============
// The bare "0 / 100%" left the reader to infer exhaustion; a chip names it, and
// the reset line is suppressed on that window (the notice above carries recovery).
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const when = surface.helpers.when;
  const tree = treeOf(render.QuotaCard, {
    label: "pool.window5h",
    window: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a zeroed window is labelled 已耗尽",
    texts(tree).includes(zh["pool.exhausted"]), texts(tree).join("\n"));
  // The reset line must NOT appear on the exhausted window (the notice owns it).
  check("the exhausted window does not also print its own reset line",
    !texts(tree).includes(zh["pool.reset"]), texts(tree).join("\n"));

  const ok = treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  });
  check("a non-zero window keeps its reset line and no exhausted chip",
    texts(ok).includes(zh["pool.reset"].replace("{time}", when(1800003600))) && !texts(ok).includes(zh["pool.exhausted"]),
    texts(ok).join("\n"));
  // 1800003600 is 2027-01-15, months from now, so the day must travel with the
  // time. The old assertion pinned the bare "重置 17:00", which read as "resets
  // later TODAY" — the weekly-reset bug.
  //
  // Both sides derive from the same epoch: `when()` renders in the runner's
  // LOCAL timezone, and pinning "01-15 17:00" is +0800's rendering — that made
  // this suite red on every UTC runner (the §30 gate incident).
  const reset = when(1800003600);
  const timeOnly = reset.split(" ").pop();
  check("a cross-day weekly reset carries its MM-DD date",
    texts(ok).join("\n").includes(reset) && !texts(ok).join("\n").includes(zh["pool.reset"].replace("{time}", timeOnly)),
    texts(ok).join("\n"));
}

// === G7. a reset clock that crosses midnight carries its day ==============
// `clock` yields HH:MM only. That is honest for the 5-hour window, but it
// rendered the WEEKLY reset — an absolute instant days away — as "重置 18:10",
// which reads as "today at 18:10". `when` keeps the compact form on the current
// local day and adds the MM-DD date once the instant falls on another day.
{
  const when = surface.helpers.when;
  const pad = (value) => String(value).padStart(2, "0");
  // A local instant `daysOut` days from now, at hour:minute.
  const at = (daysOut, hour, minute) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysOut, hour, minute).getTime() / 1000;
  };

  check("a reset still due today stays a compact HH:MM", when(at(0, 18, 10)) === "18:10", when(at(0, 18, 10)));

  const tomorrow = at(1, 18, 10);
  const tomorrowDate = new Date(tomorrow * 1000);
  check("a reset on another day carries its MM-DD date",
    when(tomorrow) === `${pad(tomorrowDate.getMonth() + 1)}-${pad(tomorrowDate.getDate())} 18:10`,
    when(tomorrow));

  const farOff = 1800003600;
  const farOffDate = new Date(farOff * 1000);
  check("a far-off weekly reset still carries its MM-DD date",
    when(farOff) === `${pad(farOffDate.getMonth() + 1)}-${pad(farOffDate.getDate())} ${pad(farOffDate.getHours())}:${pad(farOffDate.getMinutes())}`,
    when(farOff));

  check("a junk reset time degrades to the em dash",
    when(null) === "—" && when(0) === "—" && when(-1) === "—",
    `${when(null)}|${when(0)}|${when(-1)}`);

  // The card and the notice agree with the helper they share.
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;
  const weeklyCard = texts(treeOf(render.QuotaCard, {
    label: "pool.window7d",
    window: { limit: 100, used: 1, remaining: 99, resetAt: 1800003600 },
    tt: ttZh
  })).join(" ");
  check("the weekly quota card prints the date-aware reset",
    weeklyCard.includes(`重置 ${when(1800003600)}`), weeklyCard);

  const notice = rendered(render.PoolExhaustionNotice, { pools: { pools: [
    { window5h: { limit: 100, used: 1, remaining: 99, resetAt: null },
      window7d: { limit: 100, used: 100, remaining: 0, resetAt: 1800003600 } }
  ] }, tt: ttZh });
  check("the exhaustion notice carries the same date-aware weekly reset",
    notice.some((line) => line.includes(when(1800003600))), notice.join("\n"));
}

// === G8. a drifted payload degrades to a line, never a crash ==============
// The Host flags top-level shape drift but still passes the data through, so
// a pool row whose window is absent — or a trend block with no models — must
// render nothing/empty instead of throwing and blanking the whole panel. One
// malformed pool must not take the quota view (and its shape warning) down.
{
  const zh = surface.dictionaries.zh;
  const ttZh = (key) => zh[key] ?? key;

  check("a quota window that is not an object renders nothing",
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).length === 0
      && texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: undefined, tt: ttZh })).length === 0,
    texts(treeOf(render.QuotaCard, { label: "pool.window5h", window: null, tt: ttZh })).join("\n"));

  const barePool = rendered(render.PoolCard, {
    pool: { name: "通用池", poolType: "default", grantBalance: 0 }, tt: ttZh
  });
  check("a pool missing both windows still renders its identity",
    barePool.includes("通用池") && barePool.includes(zh["pool.default"]), barePool.join("\n"));

  const emptyTrend = rendered(render.TrendTable, { trend: {}, tt: ttZh });
  check("a trend block without models shows the empty note, not a crash",
    emptyTrend.includes(zh["trend.none"]), emptyTrend.join("\n"));
}

// === H. the rendering came from the shipped client ========================
// Reaching here means every extraction marker was found. These checks pin the
// lifted pieces themselves, so a refactor that silently empties one of them
// cannot read as a green suite.
{
  check("the style tokens were lifted from the client", S.card?.borderRadius === 12 && S.bar?.height === 6,
    JSON.stringify(S.card ?? {}));
  check("the number formatter was lifted", render.PoolCard instanceof Function && render.TrendTable instanceof Function
    && render.QuotaCard instanceof Function);
  check("count renders its input unchanged for small numbers",
    rendered(render.TrendTable, { trend: { models: [{ model: "m", credits: 12.345 }] }, tt }).includes("12.35"),
    "count(12.345) should round to 2 places");

  // === H2. the first frame says "loading", not "sign in" ==================
  // `viewOf(null, null)` reads as needsSetup, so the OLD PanelPage rendered
  // AccountForm for the whole first poll — `panel.loading` was dead code, and
  // a configured user saw the sign-in form flash on every mount. The
  // `loadedOnce` gate (set in the load's finally) is invisible to `viewOf`;
  // only driving the mounted page proves the gate is wired. The stand-in
  // returns useState's INITIAL value, so this is the true first frame. The
  // tab bar is part of it: the loading / error / setup states live INSIDE the
  // quota tab, so the api and raccoon tabs (both independent of the Token
  // Plan console) stay reachable before a snapshot lands.
  {
    const firstFrame = rendered(render.PanelPage, {
      onClose: () => {}, tt, localeSubscribe: undefined
    });
    check("the first frame shows the loading line", firstFrame.includes("panel.loading"),
      firstFrame.join("\n"));
    check("the first frame does NOT show the sign-in form", !firstFrame.includes("auth.title"),
      firstFrame.join("\n"));
    check("the tab bar renders before the first snapshot lands",
      firstFrame.includes("tab.quota") && firstFrame.includes("tab.api") && firstFrame.includes("tab.raccoon"),
      firstFrame.join("\n"));
  }

  // === H2b. quota-only copy never leaks into the api/raccoon header =========
  // The pinned header is now a SHELL: its right cluster is produced by
  // `HeaderStatus`, which each tab feeds with its own facts. The renewal chip
  // ("令牌自动续期中") and the stale-data banner ("读取失败") describe the
  // console login token, which the api tab (an API key) and the raccoon tab (a
  // separate gateway credential) have nothing to say about. This pin guards the
  // exact regression the demotion was meant to prevent: a quota-only chip
  // growing back into a "global" header. It mirrors the raccoon-leak pin at
  // group J (render.test.mjs:~837) that keeps the second upstream from borrowing
  // the Token Plan's rate tooltip.
  {
    const quotaChip = h("span", { style: {}, title: "x" }, "auth.selfRenew");
    const quotaFailure = { message: "boom" };
    // The raccoon tab's reported freshness (the value `PanelPage` lifts into
    // state and passes straight to `HeaderStatus` — not a ref).
    const raccoonReported = { updatedAt: 1_700_000_000_000, error: null, onRefresh: () => {} };

    // Quota: chip + banner ARE expected.
    const quotaCluster = rendered(render.HeaderStatus, {
      activeTab: "quota", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, raccoonStatus: null, tt, onRefreshQuota: () => {}
    });
    check("quota header carries the renewal chip", quotaCluster.includes("auth.selfRenew"), quotaCluster.join("\n"));
    check("quota header carries the stale-data banner", quotaCluster.includes("panel.error"), quotaCluster.join("\n"));

    // API: NEITHER the chip nor the banner may appear — it is a different
    // credential, not the console grant the chip speaks to.
    const apiCluster = rendered(render.HeaderStatus, {
      activeTab: "api", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, raccoonStatus: null, tt, onRefreshQuota: () => {}
    });
    check("api header does NOT carry the renewal chip", !apiCluster.includes("auth.selfRenew"), apiCluster.join("\n"));
    check("api header does NOT carry the stale-data banner", !apiCluster.includes("panel.error"), apiCluster.join("\n"));

    // Raccoon: only its own reported cluster (更新于 + 刷新), never the quota
    // chip or banner.
    const raccoonCluster = rendered(render.HeaderStatus, {
      activeTab: "raccoon", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, raccoonStatus: raccoonReported, tt, onRefreshQuota: () => {}
    });
    check("raccoon header does NOT carry the renewal chip", !raccoonCluster.includes("auth.selfRenew"), raccoonCluster.join("\n"));
    check("raccoon header does NOT carry the stale-data banner", !raccoonCluster.includes("panel.error"), raccoonCluster.join("\n"));
    check("raccoon header shows its own 更新于 when it has reported", raccoonCluster.includes("panel.updated"), raccoonCluster.join("\n"));

    // Raccoon, before it has reported (tab not yet mounted): no cluster at all.
    const raccoonIdle = rendered(render.HeaderStatus, {
      activeTab: "raccoon", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip, raccoonStatus: null, tt, onRefreshQuota: () => {}
    });
    check("raccoon header is empty before the tab reports", raccoonIdle.length === 0, raccoonIdle.join("\n"));

    // Raccoon, reporting a FAILED read. This is the anti-regression for the
    // write-only error state the tab used to keep: it forwarded an `error` that
    // no component rendered, so an unreachable Host left a stale 更新于 and a
    // stale roster on screen with no hint anything had failed. Both facts must
    // now be visible at once — the timestamp (still the last GOOD read) AND the
    // failure — because either one alone misleads.
    const raccoonFailed = rendered(render.HeaderStatus, {
      activeTab: "raccoon", hasData: true, updatedAt: 1_700_000_000_000,
      failure: quotaFailure, authChip: quotaChip,
      raccoonStatus: { updatedAt: 1_700_000_000_000, error: "unable to reach the Host", onRefresh: () => {} },
      tt, onRefreshQuota: () => {}
    });
    check("raccoon header surfaces its own failed read",
      raccoonFailed.includes("panel.error"), raccoonFailed.join("\n"));
    check("raccoon header still shows the last GOOD timestamp when the read failed",
      raccoonFailed.includes("panel.updated"), raccoonFailed.join("\n"));
    check("raccoon header does not borrow the quota failure message",
      !raccoonFailed.join("\n").includes("boom"), raccoonFailed.join("\n"));
    check("raccoon header keeps its own refresh button when the read failed",
      raccoonFailed.includes("panel.refresh"), raccoonFailed.join("\n"));
  }
}

// === I. the decision table: every wire code gets an answer ================
// `viewOf` is a deliberate copy of the Host's taxonomy and nothing else in the
// suite drove it, so a code added to `codes.js` and forgotten here — or a
// guidance value pointing at a dictionary key that does not exist — read as a
// green suite. The last loop is what keeps the copy honest: a bad key would
// render the key itself on screen.
{
  const { viewOf, errorOfStatus, dictionaries, tables } = surface;
  const viewOfCode = (code, message = "an error") =>
    viewOf(null, { message, code, auth: null }, tt);

  // A non-2xx snapshot response carries no body, so the status code is the only
  // clue. 401/403 must read as "the token is gone" and keep the sign-in form on
  // screen; anything else stays a plain transport string.
  for (const status of [401, 403]) {
    const rejected = errorOfStatus(status);
    check(`HTTP ${status} reads as an expired token`,
      rejected.code === "jwt_expired" && rejected.message === `HTTP ${status}` && rejected.auth === null,
      JSON.stringify(rejected));
    const rejectedView = viewOf(null, rejected, tt);
    check(`HTTP ${status} still reaches the sign-in form`,
      rejectedView.needsSetup === true && rejectedView.guidanceKey === "panel.jwtExpired",
      String(rejectedView.guidanceKey));
  }
  for (const status of [408, 429, 500, 503]) {
    check(`HTTP ${status} stays a plain transport string`,
      errorOfStatus(status) === `HTTP ${status}`, String(errorOfStatus(status)));
  }

  // The console not answering is the code this table used to have no line for:
  // the sign-in form was correctly withheld, but the reader was left with a
  // bare error string that implied a permanent failure.
  const consoleDown = viewOfCode("console_error");
  check("a console outage has its own guidance line",
    consoleDown.guidanceKey === "panel.consoleTransient", String(consoleDown.guidanceKey));
  check("a console outage does not offer the sign-in form",
    consoleDown.needsSetup === false);

  check("an expired token still names the renewal failure",
    viewOfCode("jwt_expired").guidanceKey === "panel.jwtExpired",
    String(viewOfCode("jwt_expired").guidanceKey));
  check("an unconfigured host still reaches the sign-in form",
    viewOfCode("not_configured").guidanceKey === "panel.jwtMissing"
      && viewOfCode("not_configured").needsSetup === true);

  // Every code the form must not answer to is one the table can explain.
  for (const code of tables.FORM_EXCLUDED_CODES) {
    check(`the form-excluded code ${code} keeps the form hidden`,
      viewOfCode(code).needsSetup === false);
  }

  // A guidance value is a dictionary key, in both languages.
  for (const [code, key] of Object.entries(tables.GUIDANCE_BY_CODE)) {
    check(`guidance for ${code} resolves to real text in both languages`,
      typeof dictionaries.zh[key] === "string" && typeof dictionaries.en[key] === "string", key);
  }

  // No code at all still means "the account is the answer", never a dead end.
  check("a transport failure keeps the sign-in form reachable",
    viewOf(null, "network down", tt).needsSetup === true);
  check("an unrecognised code keeps the sign-in form reachable",
    viewOfCode("some_new_code").needsSetup === true);
}

// === G6. the draw switch section is rendered and says which state it is in
// DrawSwitch IS mountable: `client-surface.js` installs a stand-in React whose
// `useState` returns the initial value and whose `useCallback` returns the
// callback, so the first frame renders exactly as it would in the browser.
// (The old note here claimed it could not be mounted, which is why the row
// regression below shipped green.)
{
  check("the draw switch component is exported by the client surface",
    typeof render.DrawSwitch === "function", String(typeof render.DrawSwitch));

  const drawLlm = {
    drawEnabled: true,
    hasApiKey: true,
    drawModel: "sensenova-u1.5-lite",
    drawCandidateIds: ["sensenova-u1-fast", "sensenova-u1.5-lite"],
    drawPreferredModel: "sensenova-u1.5-lite"
  };
  const drawTree = treeOf(render.DrawSwitch, { llm: drawLlm, tt });
  const drawText = texts(drawTree);

  // The auto row plus one row per candidate, and the status lead-in above them.
  const rows = findAll(drawTree, (props) => props.style?.borderBottom !== undefined);
  check("the draw picker draws the auto row plus every candidate",
    rows.length === 3, `rows=${rows.length}`);
  check("the draw section says it is on and names the list it introduces",
    drawText.includes("draw.onList"), drawText.join("\n"));
  check("the auto row offers the auto option",
    drawText.includes("draw.autoOption"), drawText.join("\n"));
  check("the pinned candidate is the one marked effective",
    drawText.join("").includes("draw.badge · draw.effective"), drawText.join("\n"));
  check("the auto row names the model the auto-pick addresses",
    drawText.join("").includes("draw.badge · sensenova-u1.5-lite"), drawText.join("\n"));
  check("the draw section's dictionary keys exist in zh",
    typeof surface.dictionaries.zh["draw.switch"] === "string" &&
      typeof surface.dictionaries.zh["draw.off"] === "string",
    JSON.stringify(Object.keys(surface.dictionaries.zh).filter((k) => k.startsWith("draw."))));

  // The three absence reasons: switch on, the tool never registered. Each must
  // render ITS line rather than "on — model list", which would read as
  // "drawing works". `no-tools-service` is the normal absence; the other two
  // are Host bugs and are told apart so the user does not open the log to know
  // which one happened.
  const absentReasons = [
    { reason: "no-tools-service", key: "draw.noTools" },
    { reason: "peer-load-failed", key: "draw.noToolsPeer" },
    { reason: "registry-refused", key: "draw.noToolsRefused" }
  ];
  for (const { reason, key } of absentReasons) {
    const tree = treeOf(render.DrawSwitch, {
      llm: { ...drawLlm, drawToolNote: reason },
      tt
    });
    const text = texts(tree).join("\n");
    check(`the "${reason}" absence renders its own line`,
      text.includes(key) && !text.includes("draw.onList"), text);
  }
  check("every absence line's dictionary key exists in zh and en",
    absentReasons.every(({ key }) =>
      typeof surface.dictionaries.zh[key] === "string"
        && typeof surface.dictionaries.en[key] === "string"),
    absentReasons.map(({ key }) => `${surface.dictionaries.zh[key]} / ${surface.dictionaries.en[key]}`).join(" || "));

  // The row SHAPE is a contract, not a detail: `modelRow` is a column (a head
  // line over an optional parameter line), so the name and its badge must be
  // wrapped in `modelRowHead`. Left as bare siblings they stack, `modelName`'s
  // `flex: 0 1 auto` collapses to zero width, and the row renders as a mangled
  // two-line smear — which is exactly what shipped when `modelRow` became a
  // column and only `ModelRoster` was migrated.
  {
    const columnRows = findAll(drawTree, (props) => props.style?.flexDirection === "column"
      && props.style?.borderBottom !== undefined);
    check("the draw rows are the roster's column shape",
      columnRows.length === 3, `column rows=${columnRows.length}`);
    const bare = columnRows.filter((row) => {
      const kids = (Array.isArray(row.children) ? row.children.flat(Infinity) : [row.children ?? []])
        .filter((child) => child && typeof child === "object");
      return kids.some((child) => child.props?.style === S.modelName || child.props?.style === S.modelBadge);
    });
    check("no draw row leaves its name or badge outside modelRowHead",
      bare.length === 0, `${bare.length} row(s) stack their name/badge`);
    const heads = findAll(drawTree, (props) => props.style === S.modelRowHead);
    check("every draw row wraps its head in modelRowHead",
      heads.length === 3, `heads=${heads.length}`);
  }

  // The same contract for the two other `modelRow` consumers, so the next
  // change to the row shape cannot migrate one and forget the rest.
  {
    const rosterTree = treeOf(render.ModelRoster, {
      models: [{ id: "sensenova-6.8-flash-lite", name: "SenseNova 6.8 Flash Lite", contextWindow: 262144, maxOutputLength: 65536 }],
      enabledIds: [], busy: false, tt
    });
    const raccoonTree = treeOf(render.RaccoonRoster, {
      models: [{ id: "raccoon-v1", name: "Raccoon v1", multiplier: 0, vision: true }], tt
    });
    for (const [name, tree] of [["ModelRoster", rosterTree], ["RaccoonRoster", raccoonTree]]) {
      const rowList = findAll(tree, (props) => props.style?.flexDirection === "column"
        && props.style?.borderBottom !== undefined);
      // Non-vacuity first: an empty tree would satisfy "no offenders" while
      // asserting nothing, which is how the draw regression shipped.
      check(`${name} renders its rows at all`,
        rowList.length === 1, `${name} rows=${rowList.length}`);
      const offenders = rowList.filter((row) => {
        const kids = (Array.isArray(row.children) ? row.children.flat(Infinity) : [row.children ?? []])
          .filter((child) => child && typeof child === "object");
        return kids.some((child) => child.props?.style === S.modelName || child.props?.style === S.modelBadge);
      });
      check(`${name} wraps every row's name/badge in modelRowHead`,
        offenders.length === 0, `${offenders.length} row(s) stack their name/badge`);
      check(`${name} names its model in the head line`,
        findAll(tree, (props) => props.style === S.modelName).length === 1,
        `${name} name spans=${findAll(tree, (props) => props.style === S.modelName).length}`);
    }
  }

  // The Raccoon roster's parameter line: the gateway ALREADY declares the
  // window and the output ceiling, the Host has normalized them since the
  // first release, and a name-only row was this component dropping data it
  // held. So the line is asserted in both directions — it must appear when
  // the figures are there, and must NOT appear empty when they are not.
  //
  // The thinking ladder is asserted ABSENT on purpose. This provider
  // registers `reasoning: false` (pi-ai cannot emit `extra_body.thinking`,
  // the gateway's only working channel), so quoting levels would promise a
  // selector the DSH picker never offers — the one thing worse than a sparse
  // row is a row that lies. `tt` returns the key verbatim here, so each
  // segment is pinned by WHICH template rendered, not by translated text.
  {
    const full = treeOf(render.RaccoonRoster, {
      models: [{ id: "sn-glm-5-3", name: "GLM-5.3", multiplier: 0.75, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 }],
      tt
    });
    const meta = findAll(full, (props) => props.style === S.modelMeta);
    const metaText = meta.map((row) => texts(row).join("")).join(" | ");
    check("the raccoon row quotes the declared window and output ceiling",
      meta.length === 1 && metaText.includes("llm.contextBadge") && metaText.includes("llm.metaOutput"),
      `meta lines=${meta.length} text=${metaText}`);
    check("the raccoon row never quotes a thinking ladder",
      !texts(full).join("").includes("llm.metaLevels"),
      texts(full).join(" | "));
    check("the raccoon row draws a rate chip for a priced model",
      texts(full).join("").includes("×0.75"),
      texts(full).join(" | "));
    // The rate tooltip must be the RACCOON one. `llm.rosterRateTitle` calls the
    // figure a pseudo, operator-side number ("非官方") because the Token Plan
    // rate really is configured by the operator — but this rate comes straight
    // from the gateway catalogue, and reusing that string would libel real
    // data as invented. Cheap to share, expensive to get wrong.
    const rateChips = findAll(full, (props) => props.style === S.modelRate);
    check("the raccoon rate chip does not borrow the Token Plan's pseudo-rate tooltip",
      rateChips.length === 1 && rateChips[0].props?.title === "raccoon.rateTitle",
      `chips=${rateChips.length} title=${rateChips.map((chip) => chip.props?.title).join(",")}`);

    const bare = treeOf(render.RaccoonRoster, { models: [{ id: "x", name: "X" }], tt });
    check("a row with no declared figures draws no empty parameter line",
      findAll(bare, (props) => props.style === S.modelMeta).length === 0,
      texts(bare).join(" | "));
    check("a free model reads as free, not as a rate of zero",
      texts(treeOf(render.RaccoonRoster, { models: [{ id: "f", name: "F", multiplier: 0 }], tt })).join("").includes("raccoon.free"),
      texts(treeOf(render.RaccoonRoster, { models: [{ id: "f", name: "F", multiplier: 0 }], tt })).join(" | "));
  }
}

// === Raccoon card frames ==================================================
// The tab's own frame is unreachable from this suite BY CONSTRUCTION: its data
// is internal `useState`, so mounting `RaccoonTab` always renders the
// logged-out view. `RaccoonCard` takes that state as a PROP, which is what
// makes the frames below assertable — and every one of them was previously
// unasserted, which is the whole reason the card was split out of the tab.
{
  const card = (state, extra = {}) => treeOf(render.RaccoonCard, {
    state,
    tt,
    loginBusy: false,
    loginNote: null,
    modelsNote: null,
    idsBusy: false,
    onLogin: () => {},
    onLogout: () => {},
    onSwitch: () => {},
    onIds: () => {},
    ...extra
  });
  // The first role="status"/"alert" element in tree order is the login card's
  // own status line (it is the root's first child).
  const loginLineOf = (tree) => texts(findElement(tree, (props) => props.role === "status" || props.role === "alert")).join("");
  const alertsOf = (tree) => findAll(tree, (props) => props.role === "alert");
  // Whether some text node on screen is EXACTLY `key`. Exact, not a substring:
  // `raccoon.unregistered` is a prefix of the roster chip's
  // `raccoon.unregisteredChip`, so an `includes` on the joined screen would
  // report the wording as present in a frame that does not use it.
  const lineHas = (tree, key) => texts(tree).includes(key);

  // The signed-out frame: the status says so, the button offers the scan, and
  // nothing from a previous session's state leaks in.
  {
    const tree = card({ ok: true, enabled: false, loggedIn: false });
    check("the signed-out frame names the state and offers the scan",
      loginLineOf(tree) === "raccoon.notLogged" && lineHas(tree, "raccoon.login"),
      loginLineOf(tree));
    check("a signed-out frame with the switch off draws no roster, no balance line",
      lineHas(tree, "raccoon.unregistered") && !lineHas(tree, "raccoon.pushHint")
        && !texts(tree).join("").includes("raccoon.balance"),
      texts(tree).join(" | "));
  }

  // A scan in flight: the QR is the point, and the button must not offer a
  // SECOND scan while the first one is still on screen.
  {
    const tree = card({
      ok: true, loggedIn: false, loginStatus: "scanning",
      scanUrl: "https://xiaohuanxiong.com/login/mp?code=" + "a".repeat(32)
    });
    const qr = findElement(tree, (props) => props.alt === "WeChat QR");
    check("a waiting scan puts the QR on screen",
      qr !== null && typeof qr.props.src === "string" && qr.props.src.startsWith("data:image/"),
      String(qr?.props?.src).slice(0, 24));
    const loginButton = findElement(tree, (props) => props.type === "button" && props.disabled === true);
    check("the login button stays disabled while its own scan waits",
      loginButton !== null && texts(loginButton).join("") === "raccoon.loggingIn",
      texts(loginButton ?? {}).join(""));
  }

  // The signed-in frame's whole bookkeeping is ONE line: balance, the split the
  // gateway declared, and BOTH credential clocks. Three stacked lines read as
  // clutter — but the facts must survive the fold, not be dropped by it, and a
  // zero part is a declared fact rather than a gap.
  {
    const tree = card({
      ok: true, enabled: true, loggedIn: true, nickname: "小浣熊用户",
      balance: 12345.678, balanceBreakdown: { daily: 100, reward: 0, monthly: 50 },
      expiresAtMs: 1_800_000_000_000, refreshExpiresAtMs: Date.now() + 20 * 86_400_000,
      models: [{ id: "sn-glm-5-3", name: "GLM-5.3" }], providerRegistered: true
    });
    const statusLines = findAll(tree, (props) => props.role === "status").map((el) => texts(el).join(""));
    const meta = statusLines.filter((line) => line.includes("raccoon.balance"));
    check("the signed-in bookkeeping folds into exactly one line",
      meta.length === 1, JSON.stringify(statusLines));
    const line = meta[0] ?? "";
    check("that line keeps the split the gateway declared, zero part included",
      line.includes("raccoon.partDaily") && line.includes("raccoon.partReward")
        && line.includes("raccoon.partMonthly") && !line.includes("raccoon.partTopup"),
      line);
    check("that line keeps both credential clocks",
      line.includes("raccoon.expiresAt") && line.includes("raccoon.refreshUntil"), line);
    check("a healthy signed-in session raises no alert",
      alertsOf(tree).length === 0, JSON.stringify(alertsOf(tree).map((el) => texts(el).join(""))));
    check("a visible roster stands the old unregistered wording down",
      lineHas(tree, "raccoon.pushHint") && !lineHas(tree, "raccoon.unregistered"),
      texts(tree).join(" | "));
    check("a login line with a nickname quotes it",
      loginLineOf(tree) === "raccoon.loggedIn", loginLineOf(tree));
  }

  // The nickname is absent on some gateway responses: the suffix must go, not
  // render as "已登录：" with nothing after the colon. `tt` is identity here, so
  // this is exact — `raccoon.loggedIn` is a SUBSTRING of `raccoon.loggedInPlain`
  // and a `includes` check would pass on both.
  {
    const blank = card({ ok: true, loggedIn: true, nickname: "", balance: 1 });
    check("a blank nickname drops the suffix instead of a dangling colon",
      loginLineOf(blank) === "raccoon.loggedInPlain", loginLineOf(blank));
  }

  // An expired access token is a DIFFERENT fact from "not logged in": the
  // credential row still exists and the registration may well be up, so a plain
  // status line would read as healthy while every request 401s. It must alert,
  // and the button must offer the RE-scan.
  {
    const tree = card({ ok: true, loggedIn: true, credentialExpired: true, nickname: "小浣熊用户", balance: 1 });
    check("an expired credential renders as an alert, not a status line",
      alertsOf(tree).length === 1 && loginLineOf(tree) === "raccoon.expired",
      `${alertsOf(tree).length} alert(s) / ${loginLineOf(tree)}`);
    check("an expired credential offers a re-scan rather than a logout",
      lineHas(tree, "raccoon.reLogin"), texts(tree).join(" | "));

    const blank = card({ ok: true, loggedIn: true, credentialExpired: true, nickname: "" });
    check("an expired credential with no nickname also drops the suffix",
      loginLineOf(blank) === "raccoon.expiredPlain", loginLineOf(blank));
  }

  // The two "switch on but nothing registered" wordings are the ONLY place those
  // states are named once the roster is off screen, so they must stay distinct:
  // "signed in, not yet published" is a different instruction from "not signed
  // in yet".
  {
    const awaiting = card({ ok: true, enabled: true, loggedIn: false });
    check("switch on + signed out says to sign in first",
      lineHas(awaiting, "raccoon.awaitingLogin") && !lineHas(awaiting, "raccoon.unregistered"),
      texts(awaiting).join(" | "));
    const off = card({ ok: true, enabled: false, loggedIn: false });
    check("switch off says to tick it, not to log in",
      lineHas(off, "raccoon.unregistered") && !lineHas(off, "raccoon.awaitingLogin"),
      texts(off).join(" | "));
    // Signed in but the gateway listed nothing: the roster cannot draw, so the
    // wording is what tells the reader the switch has not landed yet.
    const quiet = card({ ok: true, enabled: true, loggedIn: true, models: [] });
    check("signed in with an empty roster falls back to the wording, not to silence",
      lineHas(quiet, "raccoon.unregistered"), texts(quiet).join(" | "));
  }

  // A registration failure must stay visible while the switch is OFF: hiding it
  // behind `enabled` is a failed state with no visible affordance to act on.
  {
    const tree = card({ ok: true, enabled: false, loggedIn: false, providerError: "peer missing" });
    const box = findElement(tree, (props) => props.type === "checkbox");
    check("a registration failure is shown even with the switch off",
      box?.props?.checked === false && alertsOf(tree).length === 1
        && texts(alertsOf(tree)[0]).join("") === "peer missing",
      `checked=${String(box?.props?.checked)} alerts=${alertsOf(tree).length}`);
  }

  // The two transient notes ride in their own lines; `loginNote` is what carries
  // a walk that ended without a sign-in (the outcome is delivered once, so the
  // note is the tab's whole account of it).
  {
    const tree = card({ ok: true, enabled: false, loggedIn: false }, {
      loginNote: "scan timed out", modelsNote: "saved: 3 models", idsBusy: true
    });
    check("a walk outcome and a save result each get their own line",
      lineHas(tree, "scan timed out") && lineHas(tree, "saved: 3 models"),
      texts(tree).join(" | "));
  }

  // The card passes the curation straight through, so the roster's two Raccoon
  // defaults hold here too — an uncurated list (`null`) reads as every model
  // pushed, and a save in flight freezes the row checkboxes rather than letting
  // a second toggle race the first.
  {
    const tree = card(
      { ok: true, enabled: true, loggedIn: true, models: [{ id: "m", name: "M" }], enabledModelIds: null },
      { idsBusy: true }
    );
    const boxes = findAll(tree, (props) => props.type === "checkbox");
    check("an uncurated roster reads as every model pushed, not as none",
      boxes.length === 2 && boxes[1].props.checked === true, `boxes=${boxes.length}`);
    check("a save in flight freezes the roster's own checkboxes",
      boxes.length === 2 && boxes[1].props.disabled === true, `disabled=${String(boxes[1]?.props?.disabled)}`);
  }

  // The curation toggle is TWO-WAY, and this is the check that would have
  // caught it not being: the card used to post `current.filter((entry) =>
  // entry !== id)` for every click, so a model could be switched off and never
  // switched back on. Every frame above renders the checkbox from `state`, so
  // the wrong list was invisible — the click had to be fired and what it
  // POSTED had to be read, which is what these do.
  {
    const roster = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const click = (state, rowId) => {
      const posted = [];
      const tree = card(state, { onIds: (ids) => posted.push(ids) });
      // Skip the provider-switch box: the roster's own rows are the ones that
      // carry an `aria-label` (the switch has none), so the matcher is exact
      // rather than positional — a reordered header must not shift it.
      const rows = findAll(tree, (props) => props.type === "checkbox" && typeof props["aria-label"] === "string");
      const row = rows[rowId === "a" ? 0 : 1];
      row.props.onChange({ target: { checked: row.props.checked !== true } });
      return posted[0];
    };

    const off = click({ ok: true, enabled: true, loggedIn: true, models: roster, enabledModelIds: ["a"] }, "a");
    check("unchecking a curated model drops just that id",
      JSON.stringify(off) === JSON.stringify([]), JSON.stringify(off));

    const backOn = click({ ok: true, enabled: true, loggedIn: true, models: roster, enabledModelIds: ["a"] }, "b");
    check("re-checking an unchecked model ADDS it back (the one-way door)",
      JSON.stringify(backOn) === JSON.stringify(["a", "b"]), JSON.stringify(backOn));

    const firstOff = click({ ok: true, enabled: true, loggedIn: true, models: roster, enabledModelIds: null }, "a");
    check("the first uncheck of an uncurated roster materialises the rest",
      JSON.stringify(firstOff) === JSON.stringify(["b"]), JSON.stringify(firstOff));

    // The empty list is the state the old code could never leave: every later
    // click posted `[]` again, so the whole roster stayed off for good.
    const fromEmpty = click({ ok: true, enabled: true, loggedIn: true, models: roster, enabledModelIds: [] }, "b");
    check("a roster curated down to nothing can be turned back on",
      JSON.stringify(fromEmpty) === JSON.stringify(["b"]), JSON.stringify(fromEmpty));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
