// docs.test.mjs —— 文档与引用一致性钉子（纯文件读取：无网络、无 peer 依赖、干净检出即可跑）
//
// 守住三类「一致性纪律」：
//   文档结构（1-6）：内部链接可解析、跨文件表格去重、README 行数上限、
//                    DSH-PLUGIN.md 教学快照同步、API.md 快照契约、docs/ 孤儿文件
//   事实引用（N=条目数本身、8）：PITFALLS 条数引用有效、src/ 注释里的模块名引用完整（含伪文件名扫描）
//   自述面与实际一致（9-11）：README 覆盖每个 tab、声明的 UI 位置与 client 槽位注册一致、
//                    screenshots.json 声明的图真实存在于磁盘。这三条与 1-8 有本质区别：
//                    前两组验的是「文档格式对不对」，它们验的是「文档有没有说实话」——
//                    形式全绿而语义已漂，是本仓库踩过两次的坑（见 PITFALLS §25）。
//   裁定账本闭合（12-13）：现行文档无内联考古补丁、账本条目形状齐；
//                    且代码/测试里引用的 ADR-NNN 必须在账本里存在（曾有 ADR-006 被引用
//                    27 处却不在账本，而只校验形状的门禁全绿放过）。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "upstream" || name === ".git" || name === "node_modules") continue;
    // `tmp/` is SCRATCH and gitignored, but this walk is on disk, so whatever a
    // working session parks there gets checked. The release procedure
    // (RELEASING.md §5.5) unpacks a PUBLISHED tarball into `tmp/` on purpose —
    // and that copy's README links to `docs/*.md` which are not in the package,
    // so its links are *supposed* to be unresolvable here. Scanning scratch is
    // how a verification step turns into a false red.
    if (name === "tmp") continue;
    if (statSync(p).isDirectory()) out.push(...collectMd(p));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

const mdFiles = collectMd(ROOT).sort();
console.log(`docs.test.mjs —— 检查 ${mdFiles.length} 个 markdown 文件`);

// 1) 内部链接全部可解析
{
  let checked = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (/^(https?:|#)/.test(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue;
      checked++;
      if (!existsSync(resolve(dirname(f), pathPart))) bad(`断链：${f} -> ${raw}`);
    }
  }
  note(`内部链接 ${checked} 条全部可解析`);
}

// 2) 跨文件重复表格
{
  const seen = new Map(); // norm -> Set(file)
  for (const f of mdFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let cur = [];
    const flush = () => {
      if (cur.length >= 3) {
        const norm = cur.map((l) => l.replace(/\s+/g, "").replace(/[|`]/g, "")).join("\n");
        if (norm.length > 40) {
          const set = seen.get(norm) ?? new Set();
          set.add(f);
          seen.set(norm, set);
        }
      }
      cur = [];
    };
    for (const line of lines) {
      if (line.trim().startsWith("|")) cur.push(line.trim());
      else flush();
    }
    flush();
  }
  let dups = 0;
  for (const [norm, files] of seen) {
    if (files.size > 1) {
      dups++;
      bad(`表格「${norm.slice(0, 50)}…」重复出现在 ${files.size} 个文件：${[...files].join(", ")}（同一事实只允许一个出处）`);
    }
  }
  note(`表格去重：${seen.size} 张唯一表格，${dups} 张跨文件重复`);
}

// 3) 根 README 行数上限
{
  const lines = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).length;
  const cap = 140;
  if (lines > cap) bad(`README.md 共 ${lines} 行，超过上限 ${cap}：根 README 只做索引与快速上手，细节下沉 docs/`);
  else note(`README.md ${lines} 行（上限 ${cap}）`);
}

// 4) DSH-PLUGIN.md 教学快照 ↔ package.json
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const doc = readFileSync(join(ROOT, "docs", "DSH-PLUGIN.md"), "utf8");
  const block = doc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/DSH-PLUGIN.md 找不到 jsonc 教学快照块");
  else {
    const snip = block[1];
    for (const key of ["name", "version", "main"]) {
      const m = snip.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (!m) bad(`教学快照缺字段 "${key}"`);
      else if (m[1] !== String(pkg[key])) bad(`教学快照 "${key}" = ${m[1]}，真实 package.json = ${pkg[key]}（快照需同步）`);
    }
    const fm = snip.match(/"files"\s*:\s*\[([\s\S]*?)\]/);
    if (!fm) bad("教学快照缺 files 数组");
    else {
      const snipFiles = [...fm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const extra = snipFiles.filter((f) => !pkg.files.includes(f));
      const missing = pkg.files.filter((f) => !snipFiles.includes(f));
      if (extra.length) bad(`教学快照 files 多出：${extra.join(", ")}`);
      if (missing.length) bad(`教学快照 files 缺：${missing.join(", ")}`);
      if (!extra.length && !missing.length) note(`教学快照 files 与 package.json 一致（${snipFiles.length} 项）`);
    }
  }
}

// 5) API.md 快照示例 JSONC ↔ 声明契约
// 契约键集是 API.md 与代码之外的第三个事实源：示例手滑打错字段、或文档了代码里
// 不存在的键，都会红。示例是带省略号与注释的 JSONC，先剥注释（保字符串内 // 不动）再解析。
{
  const apiDoc = readFileSync(join(ROOT, "docs", "API.md"), "utf8");
  const block = apiDoc.match(/```jsonc\n([\s\S]*?)```/);
  if (!block) bad("docs/API.md 找不到 jsonc 快照示例块");
  else {
    const stripJsonc = (src) => {
      let out = "";
      let i = 0;
      let inStr = false;
      while (i < src.length) {
        const c = src[i];
        if (inStr) {
          out += c;
          if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
          if (c === '"') inStr = false;
          i++;
          continue;
        }
        if (c === '"') { inStr = true; out += c; i++; continue; }
        if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
        if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
        out += c;
        i++;
      }
      return out;
    };
    const cleaned = stripJsonc(block[1])
      .replace(/\s*\.\.\.\s*/g, "") // 占位省略号：{...}->{}、["..."]->[""]
      .replace(/,\s*([}\]])/g, "$1"); // 尾随逗号容错
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      bad(`API.md 快照示例不是合法 JSON：${e.message}`);
    }
    if (parsed) {
      // 契约：快照成功响应的 15 个顶层键（含条件性 visionModels）
      const canonical = ["auth", "cacheSeconds", "catalogAvailable", "catalogModels", "consoleBase", "llm", "now", "ok", "pollSeconds", "pools", "quotaError", "shapeWarnings", "trend", "uncountedModels", "visionModels"].sort().join(",");
      const docKeys = Object.keys(parsed).sort().join(",");
      if (docKeys !== canonical) bad(`API.md 快照示例顶层键与契约不符：\n  文档：${docKeys}\n  契约：${canonical}`);
      else note("API.md 快照示例顶层键与契约一致（15 键）");
      // The contract keys must appear in the code that BUILDS the snapshot
      // body. That is `snapshot-aggregate.js` (the extracted aggregation half)
      // plus `index.js` (which still assembles the error-path bodies and
      // carries the key names through its route handlers). Either file may
      // carry a key; both are required to be import-reachable from index.js.
      const indexSrc = readFileSync(join(ROOT, "src", "host", "index.ts"), "utf8");
      const aggregateSrc = existsSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"))
        ? readFileSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"), "utf8")
        : "";
      const sourceText = `${indexSrc}\n${aggregateSrc}`;
      const missing = canonical.split(",").filter((k) => !new RegExp(`\\b${k}\\b`).test(sourceText));
      if (missing.length) bad(`契约键在快照构建源码中未出现：${missing.join(", ")}`);
    }
  }
}

// 5b) client 声明的快照字段必须与 host 构造的返回体逐名一致
// 上面的 5 只钉「文档示例的键 == 契约」和「契约键出现在 host 源码里」——都
// 是弱检查：字段名作为子串出现就过，且它从不看 client 那一半。client 不能
// import host（bundle 只解析包名），所以 `wire.ts` 的 `SnapshotData` 是
// 手写的镜像，而这个镜像此前只有注释在担保。现在该声明落在
// `src/shared/wire.ts`（两端共同声明的那一份），`src/client/wire.ts` 只是它的
// 再导出面。这里把两端源码各提一次字段名做集合相等：任一边加/删/改名而不同步，
// 就红。host 侧锚定构造快照的那一个 `return {`（它设 `ok: true`），避免抓到别的
// 内层返回块。
{
  const sharedSrc = readFileSync(join(ROOT, "src", "shared", "wire.ts"), "utf8");
  const aggregateSrc = existsSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"))
    ? readFileSync(join(ROOT, "src", "host", "snapshot-aggregate.ts"), "utf8")
    : "";
  const okAt = aggregateSrc.indexOf("ok: true,");
  const retAt = aggregateSrc.lastIndexOf("return {", okAt);
  const endAt = aggregateSrc.indexOf("};", okAt);
  const hostBlock = okAt < 0 || retAt < 0 || endAt < 0 ? "" : aggregateSrc.slice(retAt, endAt);
  if (hostBlock.length === 0) bad("找不到 host 构造快照的返回块，检查 5b 本身可能已失效");
  else {
    const hostFields = new Set();
    for (const m of hostBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) hostFields.add(m[1]);       // `key:`
    for (const m of hostBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)) hostFields.add(m[1]);  // `key,` 简写
    for (const m of hostBlock.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) hostFields.add(m[1]);      // 条件展开 `{ key }`
    const iface = sharedSrc.match(/interface SnapshotData \{([\s\S]*?)\n\}/);
    if (!iface) bad("找不到 shared/wire.ts 的 SnapshotData 接口，检查 5b 本身可能已失效");
    else {
      const clientFields = new Set();
      for (const m of iface[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)) clientFields.add(m[1]);
      const hostOnly = [...hostFields].filter((f) => !clientFields.has(f));
      const clientOnly = [...clientFields].filter((f) => !hostFields.has(f));
      if (hostOnly.length || clientOnly.length || clientFields.size !== hostFields.size) {
        bad(`共享声明的快照字段与 host 构造的字段不一致（声明 ${clientFields.size} / host ${hostFields.size}）：` +
          `${hostOnly.length ? `host-only ${hostOnly.join(", ")}` : ""}` +
          `${hostOnly.length && clientOnly.length ? " | " : ""}` +
          `${clientOnly.length ? `client-only ${clientOnly.join(", ")}` : ""}`);
      } else {
        note(`共享声明的快照字段与 host 构造的字段一致（${clientFields.size} 项）`);
      }
    }
  }
}

// 6) docs/ 顶层每个文件都必须被 docs/README.md 索引表引用（README.md 本身除外）
// 防止「粘贴一段文档进来但谁都不引用」的孤儿文件：非 .md（如 .txt）与未被索引的 .md 都红。
// 索引表里指向其它目录（如 ../CHANGELOG.md）的链接不属于 docs/，不算。
{
  const readme = readFileSync(join(ROOT, "docs", "README.md"), "utf8");
  const linked = new Set(["README.md"]);
  for (const m of readme.matchAll(/\]\(\.\/([^)]+\.md)\)/g)) linked.add(m[1]);
  const docsDir = join(ROOT, "docs");
  const orphans = readdirSync(docsDir)
    .filter((name) => !statSync(join(docsDir, name)).isDirectory())
    .filter((name) => !linked.has(name));
  if (orphans.length) bad(`docs/ 顶层存在未被 docs/README.md 索引表引用的文件：${orphans.join(", ")}（孤儿文件，需入库或删除）`);
  else {
    const total = readdirSync(docsDir).filter((name) => !statSync(join(docsDir, name)).isDirectory()).length;
    note(`docs/ 顶层 ${total} 个文件全部被索引表引用`);
  }
}

// N) PITFALLS 的条目数：凡是写了「N 条」的地方，N 必须等于真实条目数
// 这些数字散在三个文件里，已经各自漂移过一次（15 / 17 并存），而 PITFALLS
// 是「改代码前先看」的第一站——一个过期数字会让读者以为自己看全了。
{
  const pitfalls = readFileSync(join(ROOT, "docs/PITFALLS.md"), "utf8");
  const actual = (pitfalls.match(/^## \d+\./gm) ?? []).length;
  let claims = 0;
  let pointed = 0;
  for (const f of mdFiles) {
    const text = readFileSync(f, "utf8");
    // 「N 条」是总数；「第 N 条」/「§N」是条号。两者都要查，但含义不同，
    // 所以 `第` 后面的数字不能当成总数——那会把一条有效引用报成数字漂移。
    // `(?<!\d)` 是必需的：「第 13 条」里的 `3 条` 也是 `\d+条`，没有它就会
    // 把一条有效引用当成总数漂移报出来。
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?<!第\s*)(?<!\d)(\d+)\s*条/g)) {
      claims += 1;
      const claimed = Number(m[1]);
      if (claimed !== actual) {
        bad(`${f.replace(ROOT + "\\", "")} 称 PITFALLS 有 ${claimed} 条，实际 ${actual} 条`);
      }
    }
    for (const m of text.matchAll(/PITFALLS\.md[^\n]*?(?:第\s*(\d+)\s*条|§\s*(\d+))/g)) {
      pointed += 1;
      const cited = Number(m[1] ?? m[2]);
      if (cited < 1 || cited > actual) {
        bad(`${f.replace(ROOT + "\\", "")} 引用 PITFALLS 第 ${cited} 条，但只有 ${actual} 条`);
      }
    }
  }
  if (claims < 2) bad(`只找到 ${claims} 处「N 条」引用，检查本身可能已经失效`);
  else note(`PITFALLS 条目数 ${actual}，${claims} 处总数引用与 ${pointed} 处条号引用全部有效`);
}

// 8) src/ 注释里的模块名引用完整性
// 事故教训：注释里 `indexts`（少了点的 index.ts）这种伪文件名曾在 21 个文件里繁殖 66 处，
// 修完 42 处又长回来——注释里的引用没人校验就不会红。这里钉两条：
//   a) 反引号里的 `Xts` / `dir/Xts` 伪文件名，若 `X.ts`/`X.js` 在 src 里真实存在，直接报错
//      （候选存在判定天然放过 hosts / attempts 这类正常英文词）；
//   b) 反引号里的 `X.ts` 式正引用必须能解析到真实文件，否则断链。
// 两个白名单名词是架构事实而非源码引用，跳过但留痕：
//   - `client.js`        根构建产物（tsdown 从 src/client 构建，gitignore，干净检出不在）
//   - `client-surface.js` loader 的模块面（仓库外约定名，见 src/client/runtime.ts 头注释）
{
  const tsFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
      else if (name.endsWith(".ts")) tsFiles.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const rel = (p) => p.replace(ROOT + "\\", "").replace(/\\/g, "/");
  const KNOWN_ARTIFACTS = new Set(["client.js", "client-surface.js"]);
  const srcCandidate = (ref) => {
    // 引用可能是 `X.ts`（同目录或 src 根）、`dir/X.ts`（src 内相对）或 `src/host/X.ts`
    // （仓库根相对，wire.ts 就这么写）；按惯例的基准全部枚举一遍
    const plain = ref.startsWith("./") ? ref.slice(2) : ref;
    const bases = [join(ROOT, "src"), join(ROOT, "src", "host"), join(ROOT, "src", "client"), ROOT];
    return bases.map((b) => join(b, plain)).filter((c) => existsSync(c));
  };
  const fileCandidates = (ref, baseDir) => [join(baseDir, ref), ...srcCandidate(ref)].filter((c) => existsSync(c));
  let pseudo = 0, checked = 0, known = 0;
  for (const f of tsFiles) {
    const text = readFileSync(f, "utf8");
    // a) 伪文件名 `Xts` / `dir/Xts`：候选真实文件存在才算数
    for (const m of text.matchAll(/`([\w-]+(?:\/[\w-]+)*)ts`/g)) {
      const x = m[1];
      const asTs = srcCandidate(`${x}.ts`);
      const asJs = srcCandidate(`${x}.js`);
      if (asTs.length || asJs.length) {
        pseudo++;
        bad(`${rel(f)} 注释伪文件名 \`${x}ts\`（应为 \`${x}.ts\`）`);
      }
    }
    // b) 正引用 `X.ts` / `dir/X.ts`（含 ./ 前缀）必须存在；两个架构名词白名单跳过但留痕
    for (const m of text.matchAll(/`((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.(?:ts|js))`/g)) {
      const ref = m[1];
      checked++;
      if (KNOWN_ARTIFACTS.has(ref)) { known++; continue; }
      if (fileCandidates(ref, dirname(f)).length === 0) {
        bad(`注释引用断链：${rel(f)} -> \`${ref}\``);
      }
    }
  }
  if (pseudo === 0) note(`注释伪文件名 0 处（${tsFiles.length} 个 src 文件）`);
  else note(`注释伪文件名 ${pseudo} 处（已在上方逐条列出）`);
  note(`注释模块引用 ${checked} 条全部可解析${known ? `（含 ${known} 条架构名词白名单）` : ""}`);
}

// 9) README 必须覆盖面板的每一个 tab
// 上面 1-8 全是形式校验：链接能解析、表格没复制、行数没超——它们对「README 说的
// 事是不是真的」一无所知。事故：0.4.3 新增第三个 tab「小浣熊」，README 零处提及，
// 而 README 进 npm 的 files 白名单——装完的用户不知道这个能力存在（PITFALLS §24）。
// 这里从两个真源派生「README 必须出现的文案」，不写死任何名字：
//   a) panel-page.ts 的 `TabId` 联合类型（activeTab 用它） -> tab id 集合
//   b) i18n.ts 里 `tab.<id>` 的中文文案（zh 字典在前，同键只取首次）
// 于是「加一个 tab 而忘了告诉用户」必然红，「改 tab 名而 README 不跟」也必然红。
{
  const panelSrc = readFileSync(join(ROOT, "src", "client", "panel-page.ts"), "utf8");
  const i18nSrc = readFileSync(join(ROOT, "src", "client", "i18n.ts"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  // 必须钉到 activeTab 的联合类型：本文件第一个 useState 是 useState<SnapshotData | null>，
  // 泛配会抓到它，反而漏掉真正的 tab 联合类型（自查时此处红过一次）。0.4.7 起该联合
  // 抽成了 `TabId`（面板三处字面量联收敛到一处声明），所以真源跟随 `export type TabId`；
  // `useState<TabId>` 仍被断言到，防止 activeTab 悄悄换回字面量联而这里还在读别名。
  const union = panelSrc.match(/activeTab,\s*setActiveTab\]\s*=\s*useState<TabId>/);
  const tabIdDecl = panelSrc.match(/export\s+type\s+TabId\s*=\s*([^;]+);/);
  if (!union) bad("src/client/panel-page.ts 找不到 activeTab 的 useState<TabId>，检查 9 本身可能已失效");
  else if (!tabIdDecl) bad("src/client/panel-page.ts 找不到 export type TabId 声明，tab id 真源断了");
  else {
    const tabIds = [...tabIdDecl[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (tabIds.length === 0) bad("activeTab 联合类型里没有解析出任何 tab id");
    else {
      const zh = new Map();
      for (const m of i18nSrc.matchAll(/"tab\.([A-Za-z]+)"\s*:\s*"([^"]+)"/g)) {
        if (!zh.has(m[1])) zh.set(m[1], m[2]); // zh 字典在 en 之前
      }
      const missingName = tabIds.filter((id) => !zh.has(id));
      const missingInReadme = tabIds.filter((id) => zh.has(id) && !readme.includes(zh.get(id)));
      if (missingName.length) bad(`i18n 里缺 tab 文案：${missingName.join(", ")}`);
      if (missingInReadme.length) {
        bad(`README 没提到这些 tab（${tabIds.length} 个 tab 必须全覆盖）：` +
          missingInReadme.map((id) => `${id}（面板文案「${zh.get(id)}」）`).join("、"));
      }
      if (!missingName.length && !missingInReadme.length) {
        note(`README 覆盖全部 ${tabIds.length} 个 tab：${tabIds.map((id) => zh.get(id)).join(" / ")}`);
      }
    }
  }
}

// 10) 自述面声明的 UI 位置必须与 client 实际注册的槽位一致
// 同一次事故的另一半：0.4.3 把面板从 sidebar 迁到 plugins.bundle.config，README 三处
// 仍写「侧边栏」，第 31 行「打开侧边栏「积分面板」」让用户找不到入口——操作级失效。
// 双向校验：哪一侧单独改都会红。
//
// 受检面**必须覆盖全部自述文档**，不能只查 README：首次只查 README + cordis.patch.yml 时，
// ARCHITECTURE / SETUP / DSH-PLUGIN / ROADMAP / CONTRIBUTING 里另外 7 处「侧边栏」全部漏网
// （SETUP 那两处还会在用户安装后直接误导操作路径）。CHANGELOG 与 PITFALLS **整file豁免**：
// 它们记录的是历史动作与事故本身（「从侧边栏归位到 Plugins 页」），写「侧边栏」是如实叙述。
{
  const clientDir = join(ROOT, "src", "client");
  // 只剥「整行都是注释」的行（`//`、`*`、`/*` 开头），不动行内 `//`——URL 里的
  // `https://` 若被当注释削掉，一条路由字符串会被截成半个，误判成「没有注册」。
  const stripCommentLines = (src) =>
    src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  let code = "";
  for (const name of readdirSync(clientDir)) {
    if (name.endsWith(".ts")) code += stripCommentLines(readFileSync(join(clientDir, name), "utf8")) + "\n";
  }
  const has = (needle) => code.includes(needle);
  const HISTORY_FILES = new Set(["CHANGELOG.md", "PITFALLS.md"]);
  const surfaces = [
    ...readdirSync(ROOT)
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n))
      .map((n) => n),
    ...readdirSync(join(ROOT, "docs"))
      .filter((n) => n.endsWith(".md") && !HISTORY_FILES.has(n))
      .map((n) => join("docs", n)),
    "cordis.patch.yml",
  ];
  const claims = [
    { words: ["侧边栏", "sidebar panel"], requires: "sidebar", via: "sidebar" },
    { words: ["Plugins 页", "plugins.bundle.config"], requires: "plugins.bundle.config", via: "plugins.bundle.config" },
  ];
  // 「不在侧边栏」这类否定句是在帮用户纠偏，不该被当成位置声明——只在肯
  // 定行上找槽位词。当初事故那句「打开侧边栏「积分面板」」不含否定词，照样红。
  //
  // 第二类豁免：**谈论「旧 / 原文 / 已过期」的句子**。文档里必须能引用一句失效的
  // 原文来说明它错在哪（例：引 PR 正文的 "for the Harness Web sidebar" 作为
  // 「该描述已过期」的证据；引用 npm 上旧 README 里还写着侧边栏入口）。这类句子
  // 是在描述「别处那份旧文本」，不是声明当前位置。判据词刻意收窄到这五个，
  // 免得把「打开侧边栏…」这种真事故也一并豁免掉。
  const NEGATIONS = [
    "不在", "不是", "并非", "不再", "已从", "迁移出", "移出", "归位",
    "仍含", "原文", "引述", "旧版", "已过期",
    "no longer", "not in the",
  ];
  const affirmative = (text) =>
    text.split(/\r?\n/).filter((l) => !NEGATIONS.some((n) => l.toLowerCase().includes(n))).join("\n");
  let wrong = 0;
  for (const file of surfaces) {
    const text = affirmative(readFileSync(join(ROOT, file), "utf8"));
    for (const claim of claims) {
      if (!claim.words.some((w) => text.toLowerCase().includes(w.toLowerCase()))) continue;
      if (!has(claim.requires)) {
        wrong++;
        bad(`${file} 声称面板在 ${claim.words[0]}，但 src/client/*.ts 里没有 ${claim.via} 槽位注册（"${claim.requires}"）——自述与实际已分头走路`);
      }
    }
  }
  if (wrong === 0) note(`自述面的面板位置与 client 槽位注册一致（受检 ${surfaces.length} 个文件：全量 docs 减 ${HISTORY_FILES.size} 个历史档）`);
}

// 11) screenshots.json 声明的每一张图必须真实存在于磁盘
// 实测事故（2026-10-01）：重截截图时文件名从 panel-credit-pools.png /
// panel-provider-setup.png 换成 panel-credit.png / panel-API-provider.png，
// assets/ 与 git 都已同步新名，**唯独 screenshots.json 还指着两个已不存在的
// 文件**——工作树干净、构建通过、其余十条检查全绿，没有任何东西在报错。
// 而这份清单是市场页取图的唯一依据（也是 npm files 白名单成员），推上去
// 就是四张图全裂。它与检查 10 是同一类病：**自述面与实际分头走路**，
// 只不过这次分头的是「清单」与「资产」。
//
// 判据全部是硬事实（文件是否存在、是不是图片、条目数在 1–8），不猜语义。
{
  const manifest = join(ROOT, "screenshots.json");
  if (!existsSync(manifest)) {
    bad("缺少 screenshots.json——市场页靠它取图，没有它市场条目无截图");
  } else {
    let list;
    try {
      list = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (e) {
      bad(`screenshots.json 不是合法 JSON：${e.message}（它是 npm files 白名单成员，坏掉会让市场取不到图）`);
    }
    if (list !== undefined) {
      if (!Array.isArray(list)) {
        bad(`screenshots.json 顶层必须是数组，实际是 ${typeof list}`);
      } else if (list.length < 1 || list.length > 8) {
        bad(`screenshots.json 有 ${list.length} 条，超出市场允许的 1–8 张`);
      } else {
        const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
        let missing = 0;
        let checked = 0;
        for (const entry of list) {
          if (typeof entry !== "string") {
            bad(`screenshots.json 含非字符串条目：${JSON.stringify(entry)}（每项都必须是路径字符串）`);
            continue;
          }
          const rel = entry.trim();
          if (rel === "") {
            bad("screenshots.json 含空条目——市场读不到路径");
            continue;
          }
          // 必须是仓库根相对路径：绝对路径与 `..` 逃逸在别人机器上解析不到，
          // 市场也读不到。
          if (rel.startsWith("/") || rel.includes("..")) {
            bad(`screenshots.json 的 "${rel}" 不是仓库根相对路径（绝对路径 / .. 逃逸在别人机器上必裂）`);
            continue;
          }
          if (!existsSync(join(ROOT, rel))) {
            missing++;
            bad(`screenshots.json 声明的 ${rel} 不存在——清单指空，市场按它取图必然裂`);
            continue;
          }
          if (!IMAGE_EXT.has(extname(rel).toLowerCase())) {
            bad(`screenshots.json 的 ${rel} 不是图片扩展名（${[...IMAGE_EXT].join("/")}）`);
            continue;
          }
          checked++;
        }
        if (missing === 0) note(`screenshots.json 的 ${checked} 张图全部存在于磁盘且为图片`);
      }
    }
  }
}

// 12) 考古纪律：现行文档不许盖「修订（日期）」式内联补丁——决策沿革只进账本
// ADR.md 的用法规则见该文件；IMPROVEMENTS.md 等研究档案天生带历史，豁免。
{
  // 账本与档案类天生带历史，豁免扫描；要豁免一篇现行文档，必须在这里有意识地
  // 加名字——新文档默认受检。为什么这样设计：ARCHITECTURE §5 曾叠出「修订
  // （日期）」沉积，新读者把历史读成现行规则；2026-10 起裁定沿革一律进
  // docs/ADR.md，正文只写现状。
  const LEDGERS = new Set([
    "ADR.md",
    "CHANGELOG.md",
    "PITFALLS.md",
    "IMPROVEMENTS.md",
    // 📦 冻结档案（2026-10-05）：时点记录，已退出持续维护面（docs/README.md 索引里标
    // 冻结、正文带冻结头注）。它们承载的是「当初怎么决策/怎么拆」的历史，不是现行规则，
    // 所以和账本一样豁免考古扫描。
    "ROADMAP.md",
    "QODER-GAP.md",
    "TOKEN-STORE-SPLIT.md"
  ]);
  const archeo = /(?:\d{4}-\d{2}-\d{2}\s*修订|修订（[一二三四五六七八九]|本节裁定已失效)/;
  let scanned = 0;
  for (const f of mdFiles) {
    if (LEDGERS.has(basename(f))) continue;
    scanned++;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const hit = line.match(archeo);
      if (hit) bad(`${f}:${i + 1} 内联考古层「${hit[0]}」——现行正文只写现状，裁定沿革进 docs/ADR.md`);
    });
  }
  // 账本自身的最小形状：存在、有条目、每条目带日期与状态——账本缺行等于没记账。
  const adrPath = join(ROOT, "docs", "ADR.md");
  if (!existsSync(adrPath)) {
    bad("docs/ADR.md（决策账本）不存在——历次裁定无处登记");
  } else {
    const adr = readFileSync(adrPath, "utf8");
    const heads = [...adr.matchAll(/^## (ADR-\d{3}[^\n]*)/gm)];
    if (heads.length === 0) bad("docs/ADR.md 没有任何「## ADR-NNN」条目");
    for (const [head, title] of heads) {
      const at = adr.indexOf(head);
      const next = adr.indexOf("\n## ADR-", at + 1);
      const block = adr.slice(at, next === -1 ? adr.length : next);
      if (!/日期/.test(block) || !/状态/.test(block)) bad(`ADR 条目缺日期/状态行：${title.trim()}`);
    }
    note(`考古纪律：受检 ${scanned} 篇现行文档零内联补丁；账本 ${heads.length} 条目形状合格（日期/状态齐）`);
  }
}

// 13) 代码/测试里引用的 ADR 编号必须在账本里存在
// 事故（2026-10-03）：ADR-006（状态文件写侧版本护栏）被 src/ 的五个 store +
// state-store + 四个测试套件共 27 处注释引用，却从未在 docs/ADR.md 落条目——
// 上面第 12 项只校验条目**形状**（日期/状态齐不齐），从不校验**存在性**，所以它
// 带着 27 处引用全绿通过。一个"已被代码依赖的裁定"缺席账本，等于裁定理由、
// 取代关系与推翻它的能力全部无处可查（本插件的账本正是为此建立的）。
// 这里沿用第 8 项的模式：walk src/ 与 test/，凡是引用了 ADR-NNN 就要求它入账。
// 白名单只放本仓库无意的字符串命中（如正则在讲 ADR 形状本身）。
{
  const adrPath = join(ROOT, "docs", "ADR.md");
  const ledger = existsSync(adrPath)
    ? new Set([...readFileSync(adrPath, "utf8").matchAll(/^## (ADR-\d{3})/gm)].map((m) => m[1]))
    : new Set();
  const codeFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
      else if (/\.(ts|mjs|js)$/.test(name)) codeFiles.push(p);
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "test"));
  const rel = (p) => p.slice(ROOT.length + 1).split("\\").join("/");
  // The DOCS are scanned too, not just code. Trigger (2026-10-05): the walk
  // covered only src/ + test/, so the day ARCHITECTURE §5.6 gained its pointer
  // to a new ledger entry, deleting that entry from ADR.md left this whole
  // suite green — verified by actually deleting it. A ruling that only prose
  // points at is exactly as untraceable as one only code points at; the
  // original 2026-10-03 accident (a state-guard ruling referenced 27× from
  // src/, absent from the ledger) is the same hole one level over.
  //
  // NOTE for whoever edits this comment: this file is itself scanned, and the
  // scan is a bare regex over the whole text. Do NOT spell a ruling id out in
  // prose here — a comment citing "ADR-0NN" registers as a reference and will
  // fail the build if that entry is ever renamed or removed. Referring to
  // rulings by section number only is the convention that keeps this comment
  // honest. docs/ADR.md is excluded because a ledger legitimately cites its
  // own superseded rulings.
  const docFiles = [];
  const walkDocs = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const q = join(dir, name);
      if (statSync(q).isDirectory()) {
        if (["node_modules", "upstream", ".git"].includes(name)) continue;
        walkDocs(q);
      } else if (name.endsWith(".md")) docFiles.push(q);
    }
  };
  walkDocs(join(ROOT, "docs"));
  for (const name of readdirSync(ROOT)) if (name.endsWith(".md")) docFiles.push(join(ROOT, name));
  const scan = [...codeFiles, ...docFiles.filter((f) => rel(f) !== "docs/ADR.md")];
  const seen = new Map(); // id -> 首个引用处
  for (const f of scan) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/ADR-\d{3}/g)) {
      if (!seen.has(m[0])) seen.set(m[0], `${rel(f)}:${text.slice(0, m.index).split(/\r?\n/).length}`);
    }
  }
  // 账本自身引用它自己的条目是合法的（如 ADR-005 块内的"取代：ADR-xxx"占位）。
  // 但 docs/ADR.md 不在 codeFiles 里（只 walk src/ 与 test/），故无需豁免。
  for (const [id, where] of [...seen.entries()].sort()) {
    if (!ledger.has(id)) {
      bad(`引用了账本里没有的裁定 ${id}（首个引用 ${where}）——在 docs/ADR.md 补一条 "## ${id} …" 条目`);
    }
  }
  note(`ADR 引用闭合：src/ + test/ + docs/ 引用的 ${seen.size} 个编号（${[...seen.keys()].sort().join(", ") || "无"}）全部在账本中存在`);
}

// 14) 现行文档里源码引用的扩展名必须与 src/ 一致（.js → .ts）
// 事故教训（2026-10-05）：源码 2026-09-30 全量 .ts 化后，现行手册里仍留着
// `llm-models.js` / `codes.js` / `throttle-store.js` 这类**按名找不到**的引用——
// `llm-models.js` / `codes.js` / `throttle-store.js` 这类**指向产物而非源码**的
// 引用——文档该指向 src/ 下的 .ts（`lib/` 里的 chunk 名与源码同名，指向产物会让
// 「读源码」和「读产物」混成一团）；门禁 1-13 只查链接/条目数/契约，
// 不查反引号裸引用，于是全绿放过了整整一类。本次共修 17 处。
// 豁免两件事：
//   ① 历史/研究/路线图档与版本账（IMPROVEMENTS / TOKEN-STORE-SPLIT /
//      ROADMAP / CHANGELOG）的当时名是准确历史，改掉反而失真
//      （如 `index.js` 1187→778 行的叙述、0.4.2「新增 `routes.js`」）；
//      本门禁守的是**读者会按名去找文件**的现行操作手册，不是版本账。
//   ② 构建产物与测试基建（`lib/index.js`、裸 `index.js`、`client.js`、
//      `client-surface.js`、`panel-decision.js`、`panel-render.js`）是真实
//      存在的 .js，不受 TS 化影响。
// 商汤官方文档容器（docs/sensenova-api-reference/）不是本插件文档，跳过。
// 判定只问「src/ 下有没有同名 .ts」——因此 `client.js`（src 下无 client.ts）
// 这类天然不会误报，`hosts` / `attempts` 之类英文词也不是 `X.js` 形态。
{
  const tsBase = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); }
      else if (name.endsWith(".ts")) tsBase.add(name.slice(0, -3));
    }
  };
  walk(join(ROOT, "src"));
  const EXEMPT_FILES = new Set([
    "docs/IMPROVEMENTS.md",
    "docs/TOKEN-STORE-SPLIT.md",
    "docs/ROADMAP.md",
    "CHANGELOG.md"
  ]);
  const KNOWN_ARTIFACTS = new Set([
    "index.js",
    "client.js",
    "client-surface.js",
    "panel-decision.js",
    "panel-render.js"
  ]);
  const rel = (p) => p.slice(ROOT.length + 1).split("\\").join("/");
  const hits = [];
  for (const f of mdFiles) {
    const r = rel(f);
    if (EXEMPT_FILES.has(r) || r.startsWith("docs/sensenova-api-reference/")) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/`([A-Za-z0-9_./-]+\.js)`/g)) {
        const ref = m[1];
        if (ref.includes("lib/") || KNOWN_ARTIFACTS.has(ref)) continue;
        const base = ref.split("/").pop().slice(0, -3);
        if (tsBase.has(base)) hits.push(`${r}:${i + 1} \`${ref}\` 应写 \`${base}.ts\``);
      }
    }
  }
  for (const h of hits) bad(`现行文档引用了已 TS 化的源码扩展名：${h}——源码 2026-09-30 起全量 .ts，按名找不到 .js`);
  note(`现行文档源码引用扩展名 ${hits.length} 处漂移（.js 应为 .ts）`);
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
