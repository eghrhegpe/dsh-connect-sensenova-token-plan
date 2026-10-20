/**
 * 宿主 peer 范围 × 真实发布宇宙的对齐门禁。
 *
 * ## 守什么，不守什么
 *
 * `package.json` 里那 10 条 `@deepseek-ai/dsh-*` peer 范围是**声明**：宿主拿
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 决定某个运行时
 * 版本能不能装本插件（`dsh-app-boot` 的兼容闸）。声明写错了不会有编译错误、不会有别的
 * 套件变红——它只是**安静地接受或拒绝一批版本**。
 *
 * 本套件把「这条范围在真实发布史上到底放行哪些版本」冻结进
 * `test/host-range.golden.json`，每次跑都对一遍，红了逐个版本点名。
 *
 * 它守的是**对齐**（范围与版本宇宙是否还匹配），不是**行为**（插件在那个版本上能不能跑
 * 起来）。后者要真装真启，那是 `e2e-gate.mjs` 那一档的事，本套件不做。
 *
 * ## 为什么 `>=0.1.5` 这个下界不是它看起来的样子
 *
 * `">=0.1.5 <0.3"` 读起来是「0.1.5 及以上」，实际语义是「**0.1.6-alpha.1** 及以上」：
 * 0.1.5 是稳定版，预发布排序低于自身，所以 0.1.5 自己的 alpha/rc 全部被拒——写作者以为
 * 放行的，正是它拒绝的那批。反过来它又**主动接收** 0.1.6-alpha.1、0.1.7-alpha.1、
 * 0.2.1-alpha.1 这些内测版。两个方向都只有把范围拿去跑一遍真实版本表才看得见，这就是本
 * 文件的全部意义。
 *
 * ## 为什么在默认门禁里
 *
 * `test/suites.mjs` 是显式名册，所以本套件要有人在那儿加一行才会跑（已加）。它零网络、
 * 零安装，只读 `package.json` 与 golden 两个文件；刷新 golden 走
 * `tools/update-host-range.mjs`（唯一联网的地方，不在任何门禁路径上）。
 *
 * ## 红了怎么办
 *
 * 三种可能：上游发了新运行时版本（→ 跑生成器刷新，然后**用人的判断**看那个新版本该不该
 * 被收）；范围被人改了（→ 有意就刷新，手滑就改回去）；golden 被手改坏了（→ 它是生成物，
 * 别手改）。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { results, check, finish } from "./harness.mjs";
import {
  compareVersions,
  diffAgainstGolden,
  explain,
  hostPeers,
  partition
} from "./host-range.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(here, "host-range.golden.json"), "utf8"));

/** 已发布的全部 `@deepseek-ai/dsh` 版本，按 semver 升序。 */
const universe = golden.universe ?? [];
const peers = golden.peers ?? {};

// --- 1. golden 的宇宙 = 已发布的全部版本，不是抽样 -------------------------

check("golden carries a non-empty universe", universe.length > 0, `n=${universe.length}`);

// 宿主判的是**运行时版本**，不是 peer 包自己的版本：`@deepseek-ai/dsh-settings@0.1.2-alpha.3`
// 是那个包的发布节奏，与任何会加载本插件的宿主无关。
check(
  "the universe is anchored on the host runtime, not on a peer package",
  golden.universePackage === "@deepseek-ai/dsh",
  String(golden.universePackage)
);

// 注册表返回的是**发布序**（0.2.1-alpha.1 发布在 0.2.0-rc.2 之后），不是版本序；生成器排过
// 序，这里复核——没排序的黄金表会让「最新放行版本」算错。
{
  const broken = [];
  for (let i = 1; i < universe.length; i++) {
    if (compareVersions(universe[i - 1], universe[i]) >= 0) broken.push(`${universe[i - 1]} !< ${universe[i]}`);
  }
  check("the universe is in semver order with no duplicates", broken.length === 0, broken.slice(0, 5).join(", "));
}

// 每个代际至少一个锚点。全丢说明扫描没够到输入（或 golden 被截断过）。
{
  const missing = ["0.1.7-rc.1", "0.2.0-rc.1", "0.2.1-rc.2"].filter((anchor) => !universe.includes(anchor));
  check("the universe still spans every generation", missing.length === 0, `missing: ${missing.join(", ")}`);
}

// --- 2. 每条 peer 范围的判定与记录一致 ------------------------------------

{
  const report = diffAgainstGolden(manifest, golden);
  check(
    "every host-gated peer range still scores the same against the universe",
    report.length === 0,
    report.length === 0
      ? ""
      : `${explain(report)}\n（上游发版或范围改动都会走到这里；确认后用 node tools/update-host-range.mjs 刷新）`
  );
}

// --- 3. 记录的分区与它自己的范围自洽（防手改 golden） ---------------------

{
  const inconsistent = [];
  for (const [name, entry] of Object.entries(peers)) {
    const derived = partition(universe, entry.range);
    if (derived.admitted.join(",") !== (entry.admitted ?? []).join(",")) {
      inconsistent.push(`${name} 的 admitted 与 range "${entry.range}" 不自洽`);
      continue;
    }
    if (derived.admitted.length + derived.refused.length !== universe.length) {
      inconsistent.push(`${name} 的分区长度不等于宇宙长度`);
    }
  }
  check(
    "each recorded partition is self-consistent with its own range",
    inconsistent.length === 0,
    `${inconsistent.join("; ")}（golden 是生成物，别手改）`
  );
}

// 反向：磁盘上每条 host peer 都必须有记录——否则「新增了一条 peer 依赖却没人给它评分」，
// 它会悄悄收进版本而零记录。
{
  const recorded = new Set(Object.keys(peers));
  const missing = hostPeers(manifest)
    .map(([name]) => name)
    .filter((name) => !recorded.has(name));
  check("every host peer on disk has a golden entry", missing.length === 0, `未记录：${missing.join(", ")}`);
}

// 活性下限：这个仓库是靠 peer 吃饭的，一条 host peer 都没有说明提取逻辑坏了，而上面那条
// 「全部记录」会在空集上恒真。
check(
  "the manifest still declares host peers at all",
  hostPeers(manifest).length >= 5,
  `n=${hostPeers(manifest).length}`
);

// --- 4. 下界不会被静默上舍 ------------------------------------------------
//
// `>=0.1.5` 配预发布宇宙时，写作者以为的「X.Y.Z 及以上」实际是「X.Y.Z 之后的第一个预发布
// 及以上」。这条把那个语义差钉出来。若哪天真要「从 0.1.5 起」，正确写法是
// `>=0.1.5-rc.1` 之类——改完这条断言会自动跟随，因为它从 range 里读。
{
  const offenders = [];
  for (const [name, entry] of Object.entries(peers)) {
    const floor = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(entry.range);
    if (!floor) continue;
    if (floor[1].includes("-")) continue; // 下界自带预发布标签，本检查不适用
    const own = `${floor[1]}-rc.1`;
    if (!universe.includes(own)) continue;
    if ((entry.admitted ?? []).includes(own)) offenders.push(`${name} 放行了 ${own}`);
  }
  check("a stable floor does not silently round up to its own pre-releases", offenders.length === 0, offenders.join("; "));
}

// --- 5. 实际验证过的宿主版本都被放行 -------------------------------------

// `validatedOn` 是「这个插件真的在哪些宿主上跑过」的账本（证据写在生成器里）。它必须既在
// 宇宙里、又被每条 peer 放行——否则等于「我们验证过的版本，自己的声明却拒之门外」。
{
  const validatedOn = golden.validatedOn ?? [];
  check("the validatedOn ledger is not empty", validatedOn.length > 0);

  const absent = validatedOn.filter((version) => !universe.includes(version));
  check(
    "every validated host is inside the universe",
    absent.length === 0,
    `${absent.join(", ")} 不在宇宙里（版本消失或 golden 被截断）`
  );

  const refused = [];
  for (const version of validatedOn) {
    for (const [name, entry] of Object.entries(peers)) {
      if (!(entry.admitted ?? []).includes(version)) refused.push(`${name} 拒绝 ${version}`);
    }
  }
  check("the range admits every host this build was validated on", refused.length === 0, refused.join("; "));
}

// --- 6. 0.x 之外不外泄 ----------------------------------------------------

// 上限一律写 `<0.3`（desugar 成 `<0.3.0-0`）。跨 minor 是 ABI 断裂线，收进来就等于宣称
// 「下一代会跑」而没有一行验证。
{
  const leaked = [];
  for (const probe of ["0.3.0", "1.0.0"]) {
    for (const [name, entry] of Object.entries(peers)) {
      if ((entry.admitted ?? []).includes(probe)) leaked.push(`${name} 放行了 ${probe}`);
    }
  }
  check("nothing outside the 0.x line sneaks in", leaked.length === 0, leaked.join("; "));

  // 反向活性证明：若范围塌成只拒，上一条会恒真而毫无意义。
  const anyAdmitted = Object.values(peers).some((entry) => (entry.admitted ?? []).some((v) => v.startsWith("0.2.")));
  check("some 0.2.x is admitted, so the refusal above is not vacuous", anyAdmitted);
}

// --- 7. 比较器与宿主真正在用的 semver 对拍 -------------------------------

// 本仓库自带一份零依赖比较器（`test/host-range.mjs`），是故意重写的。重写就有偏离风险，
// 所以拿宿主那份 semver（dsh 自带的 7.x）对同一批输入逐个比对。找不到宿主副本时打印 SKIP
// 而不是失败——干净检出不装任何东西是这个仓库的前提（同 `peer-roots.mjs` 的立场）。
function loadHostSemver() {
  const candidates = [];
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) candidates.push(join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "semver"));
  } catch {
    // 没有 npm / 没有全局树：下面还有裸 semver 可试。
  }
  candidates.push("semver");
  const require = createRequire(join(root, "package.json"));
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded.satisfies === "function") return loaded;
    } catch {
      // 试下一个。
    }
  }
  return null;
}

{
  const semver = loadHostSemver();
  if (semver === null) {
    console.log("SKIP: 既没有宿主那份 semver 也没有裸 semver，对拍未运行");
  } else {
    // 不只比本仓的 range：混进几条已知陷阱形式，防止「比较器只对自己的输入正确」。
    const ranges = [
      ...hostPeers(manifest).map(([, range]) => range),
      "<0.2",
      ">=0.1.5 <0.3",
      ">=0.1.7-rc.1 <0.3.0-0",
      ">=0.2.0-rc.0 <0.3"
    ];
    const disagreements = [];
    let compared = 0;
    for (const range of ranges) {
      for (const version of universe) {
        const ours = partition([version], range).admitted.length === 1;
        const theirs = semver.satisfies(version, range, { includePrerelease: true });
        compared++;
        if (ours !== theirs) disagreements.push(`${version} × "${range}": 本仓=${ours} 宿主=${theirs}`);
      }
    }
    check(
      "the comparator agrees with the semver the host actually uses",
      disagreements.length === 0,
      disagreements.slice(0, 10).join("\n")
    );
    // 活性：没比到东西也算红——「一致」不能由零组输入凑出来。
    check(
      "the cross-check actually compared something",
      compared >= ranges.length * 10,
      `compared=${compared}`
    );
  }
}

// 记录条数下限：报告失败时能看出「到底跑了几条」，也让误删整段在 diff 里显眼。
check("the suite recorded a substantial ledger", results.length >= 10, `n=${results.length}`);

finish();
