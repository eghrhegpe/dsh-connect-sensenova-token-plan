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
//   裁定账本闭合（12-13）：现行文档与 src/ 注释无内联考古补丁/搬家叙述（ADR-014）、
//                    账本条目形状齐；且代码/测试里引用的 ADR-NNN 必须在账本里存在
//                    （曾有 ADR-006 被引用 27 处却不在账本，而只校验形状的门禁全绿放过）。
//   变更日志分工（15）：CHANGELOG 只记公开行为变化——不写实现坐标（src/、test/）、
//                    测试工程词（变异 / 断言级 / 套件 / fixture）与 commit hash；
//                    版本导语 ≤ 90 字（先给结论）。
//   索引与真源闭合（16）：TESTING.md §2 的套件表必须与 test/suites.mjs 的名册
//                    双向闭合——新套件登了名册却忘了登表，是纯人肉步骤、不会自己变红。
//   数值副本看守（17）：文档正文复述的配置默认值 / 缓存 TTL / 路由 body 上限必须等于
//                    源码常量。副本本身不可怕，**没有看守的副本**才可怕——SETUP.md 的
//                    配置表此前自称被 config.test.mjs 钉住，实际全仓没有测试读它。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// 名册是机器真源，TESTING.md §2 的套件表是人读索引——检查 16 把两者钉在一起。
// 这里 import 的是纯数据模块（无副作用、无 peer），docs.test.mjs 因此仍是干净检出可跑。
import { SUITES, EXEMPT } from "./suites.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const note = (m) => console.log(`  ok - ${m}`);
const bad = (m) => fails.push(m);

function collectMd(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // `awesome-dsh-plugin-submission/` holds a verbatim copy of the upstream
    // contributing guide. Its relative links (`data/screenshots.json`, `data/plugins/…`)
    // resolve inside THAT repository, not this one — scanning it can only produce
    // false reds, the same reason `upstream/` and `tmp/` are skipped below.
    if (name === "awesome-dsh-plugin-submission") continue;
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

// 📦 冻结档案（2026-10-05）：时点记录，已退出持续维护面（docs/README.md 索引里标冻结、
// 正文带冻结头注）。它们承载的是「当初怎么决策/怎么拆」的历史，不是现行规则，因此
// 考古扫描（检查 12）与数值副本核对（检查 17）都跳过——冻结档里的旧数字是准确历史。
const FROZEN_DOCS = new Set(["ROADMAP.md", "QODER-GAP.md", "TOKEN-STORE-SPLIT.md", "SIBLING-GAP.md", "SIBLING-GAP-2.md"]);

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
  // 2026-10-21：README 与 TROUBLESHOOTING 都不再复述总数（改成「条数见该文件头，别写死」），
  // 于是「检查还有没有看守对象」不能再用「≥2 处写总数」判——那等于逼人把会腐坏的数字写回去。
  // 新判据：**总数副本 0 处是目标**，但指向具体条号的引用仍必须 ≥2 处且可解析；
  // 若有人重新写死一个总数，上面的循环照旧比值，不会因此放过。
  if (pointed < 2) bad(`现行文档里只有 ${pointed} 处指向 PITFALLS 具体条号（总数副本 ${claims} 处），检查本身可能已经失效`);
  else note(`PITFALLS 条目数 ${actual}：条号引用 ${pointed} 处全部可解析，总数副本 ${claims} 处（本仓已不再复述总数）`);
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

  // 反向：assets/ 里每张图都必须被按名字引用（清单或 README），不留孤儿资产。
  // 现象（2026-10-19）：新增一张截图放进 assets/，README 与 screenshots.json 都没提，
  // git 也未跟踪——上面那段只验「声明了就必须在盘上」，反方向没有检查，于是全绿。
  // 市场对无声明条目会回落到从 README 抽图，所以 README 里引用同样算「会被展示」。
  const ASSETS = join(ROOT, "assets");
  if (existsSync(ASSETS)) {
    const IMG = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    const declared = new Set();
    if (existsSync(manifest)) {
      try {
        const list = JSON.parse(readFileSync(manifest, "utf8"));
        if (Array.isArray(list)) for (const e of list) if (typeof e === "string") declared.add(basename(e.trim()));
      } catch {
        /* JSON 坏掉已在上文报过，这里不重复 */
      }
    }
    const readmePath = join(ROOT, "README.md");
    const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
    let orphans = 0;
    for (const name of readdirSync(ASSETS)) {
      if (!IMG.has(extname(name).toLowerCase())) continue;
      if (declared.has(name) || readme.includes(name)) continue;
      orphans++;
      bad(`assets/${name} 是孤儿资产——screenshots.json 与 README 都没按名字引用它，市场与 README 都不会展示它（要么加进清单并在 README 补上下文，要么删掉）`);
    }
    if (orphans === 0) note(`assets/ 的 ${readdirSync(ASSETS).filter((n) => IMG.has(extname(n).toLowerCase())).length} 张图全部被 screenshots.json 或 README 引用（无孤儿资产）`);
  }
}

// 12) 考古纪律：现行文档不许盖「修订（日期）」式内联补丁——决策沿革只进账本
// ADR.md 的用法规则见该文件；IMPROVEMENTS.md 等研究档案天生带历史，豁免。
{
  // 账本与档案类天生带历史，豁免扫描；要豁免一篇现行文档，必须在这里有意识地
  // 加名字——新文档默认受检。为什么这样设计：ARCHITECTURE §5 曾叠出「修订
  // （日期）」沉积，新读者把历史读成现行规则；2026-10 起裁定沿革一律进
  // docs/ADR.md，正文只写现状。
  // 账本与冻结档都豁免考古扫描：前者记沿革，后者是时点记录（见文件头的 FROZEN_DOCS）。
  const LEDGERS = new Set(["ADR.md", "CHANGELOG.md", "PITFALLS.md", "IMPROVEMENTS.md", ...FROZEN_DOCS]);
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
  // src/ 代码注释同一条纪律（ADR-014）：红的是「搬家叙述」——「某日从前一个文件
  // 拆出／移到某处」式沿革句，那属于账本；模块头部该留的只是当下的职责与邻接。
  // 实测/probe/复核日期**不在**此列：证据不是考古——这里只列本仓真实出现过的形态，
  // 不搞「凡带日期的行都红」，llm-models 的 probe 日期照常绿着过。
  const SRC = join(ROOT, "src");
  const srcArcheo = [
    [/Split out of the former/, "搬家叙述「Split out of the former …」"],
    [/Extracted 20\d\d/, "搬家叙述「Extracted <年份>」"],
    [/（20\d\d-\d\d-\d\d\s*(?:落地|修)）/, "日期内联补丁「（YYYY-MM-DD 落地/修）」"],
    [/\*\* \(20\d\d-\d\d-\d\d\)/, "标题后的日期内联补丁「**…** (YYYY-MM-DD)」"],
  ];
  const tsFiles = [];
  (function collect(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".ts")) tsFiles.push(p);
    }
  })(SRC);
  for (const f of tsFiles) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, what] of srcArcheo) {
        if (re.test(line)) {
          bad(`${f.slice(ROOT.length + 1)}:${i + 1} ${what}——注释只写当下的形状，何时搬去过哪写进 docs/ADR.md`);
        }
      }
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
    note(`考古纪律：受检 ${scanned} 篇现行文档与 src/ 的 ${tsFiles.length} 个 .ts 零搬家叙述；账本 ${heads.length} 条目形状合格（日期/状态齐）`);
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

// 15. CHANGELOG 分工纪律（把 CHANGELOG.md:3 的自我声明变成可执行检查）
//
// 由来：第 3 行写明「本文件只记公开行为变化……实现细节、重构与测试加固请直接看 git log」，
// 但 0.5.x / 0.6.0 实际写成了工作日志——0.6.0 导语 149 字、0.5.0 单条 525 字，
// 用户想 40 字看完新功能，读到的却是测试门禁、变异矩阵与 src/ 文件坐标。
// 四条口径：
//   a. 小标题不得自称「用户不可见 / 发布质量」——自我声明为发布质量的内容，
//      按第 3 行本就不该留在本文件（该撤稿，而不是加个标记免责）；
//   b. 不写 commit hash（属于 git log 与 Release body，写进正文还会随 rebase 腐坏）；
//   c. 自 0.5.0 起的条目不写实现坐标（src/、test/）与测试工程词，只讲行为与影响；
//   d. 自 0.5.0 起的版本导语 ≤ 90 字（0.5.2 是范本：83 字讲完 5 条修复）。
// 0.5.0 之前是考古，不回填；本门禁只保证新版本不再回潮。
{
  const rel = "CHANGELOG.md";
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  const tuple = (m) => (m[3] === "x" ? [-1, -1, -1] : [Number(m[1]), Number(m[2]), Number(m[3])]);
  const atLeast = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };

  let selfDeclared = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{3,4} /.test(lines[i])) continue;
    if (!/用户不可见|发布质量/.test(lines[i])) continue;
    selfDeclared++;
    bad(`${rel}:${i + 1} 小标题自称「用户不可见 / 发布质量」：${lines[i].trim()}——第 3 行已声明本文件只记公开行为变化，这类内容留在 git log / Release body，加标记不等于可以留`);
  }
  note(`${rel} 自称「用户不可见 / 发布质量」的小标题 ${selfDeclared} 处`);

  let hashes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/`[0-9a-f]{7}`/.test(lines[i])) continue;
    hashes++;
    bad(`${rel}:${i + 1} 写入 commit hash：${lines[i].trim().slice(0, 60)}…——哈希属于 git log 与 Release body，本文件只记公开行为变化`);
  }
  note(`${rel} 行内 commit hash ${hashes} 处`);

  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## \[(\d+)\.(\d+)\.(\d+|x)\]/);
    if (m) heads.push({ i, ver: tuple(m) });
  }
  const JARGON = /(src|test)\/|变异(测试|矩阵|存活)|条断言|断言级|测试套件|单测|回归测试|fixture|jsdom|coverage/;
  let windowed = 0;
  let longIntro = 0;
  let jargon = 0;
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    if (!atLeast(h.ver, [0, 5, 0])) continue;
    windowed++;
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    let j = h.i + 1;
    while (j < end && !lines[j].trim()) j++;
    let intro = "";
    while (j < end && lines[j].trim()) { intro += lines[j]; j++; }
    if (intro.length > 90) {
      longIntro++;
      bad(`${rel} 版本 ${h.ver.join(".")}（第 ${h.i + 1} 行）导语 ${intro.length} 字，超过 90 字上限——导语只回答「这版给用户带来了什么」，过程留给下面的条目与 git log`);
    }
    for (let x = h.i + 1; x < end; x++) {
      const m = lines[x].match(JARGON);
      if (!m) continue;
      jargon++;
      bad(`${rel}:${x + 1} 条目出现实现坐标 / 测试工程词「${m[0]}」：${lines[x].trim().slice(0, 50)}…——第 3 行声明实现细节与测试加固看 git log，这里只留行为与影响`);
    }
  }
  note(`${rel} 0.5.0 起 ${windowed} 个版本受分工纪律约束（导语超限 ${longIntro} 处、实现坐标 / 测试词 ${jargon} 处）`);
}

// 16) TESTING.md §2 的套件表 ↔ 门禁名册双向闭合
//
// 「新套件登记进名册，却没人记得登进 TESTING.md 的表」是一个纯人肉步骤：
// silent-catch.test.mjs 落地时就是靠人记得补了一行（当时还发现表里 4 处硬编码
// 项数早已腐掉）。名册是机器真源（test/suites.mjs，`npm run test:list` 自证），
// 表是人读索引——两者漂移时，文档会先于代码过期，而这类缺陷不会自己变红。
// 与 package.test.mjs 的 disk ⊆ roster 同款：闭合集合必须双向断言。
{
  const rel = "docs/TESTING.md";
  const text = readFileSync(join(ROOT, rel), "utf8");
  const rows = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`test\/([^`]+)`\s*\|/);
    if (m) rows.add(m[1]);
  }
  // 表里允许出现「不在默认名册」的行：EXEMPT（联网档，默认不得进链）与两个
  // live 脚本——它们是 npm script 的便利入口，刻意不进默认门禁。
  const allowedExtra = new Set([...EXEMPT, "live-contract.mjs", "live-raccoon.mjs"]);
  const inRoster = new Set(SUITES.map((s) => s.name));
  let missing = 0;
  for (const s of SUITES) {
    if (rows.has(s.name)) continue;
    missing++;
    bad(`${rel}: 名册里的 ${s.name}（kind=${s.kind}）没有出现在 §2 的套件表里——新增套件要连文档一起登记（名册是机器真源，表是人读索引，漂移时文档先过期）`);
  }
  let stale = 0;
  for (const r of rows) {
    if (inRoster.has(r) || allowedExtra.has(r)) continue;
    stale++;
    bad(`${rel}: 表里的 ${r} 既不在门禁名册里、也不在豁免集里——套件被退役或改名后，这一行会静默腐烂`);
  }
  // 下限：表被整体删掉时（rows 塌空）「僵尸行 0」绝不能读成合规——真源里
  // 名册永远非空，缺行会逐条红，但先把扫描本身够没够到输入说清楚。
  if (rows.size < 20) bad(`${rel}: 只解析到 ${rows.size} 行套件表——扫描没够到输入（表被删或被改写），这一轮什么都没验到`);
  note(`${rel} 套件表 ↔ 名册：名册 ${SUITES.length} 项 / 表内 ${rows.size} 行（缺 ${missing}、僵尸 ${stale}）`);
}

// 17) 数值事实副本一致性：文档正文里复述的数值必须等于源码常量
//
// 「一个事实一个出处」只挡得住逐字重复，挡不住**数值副本**：同一句「余额缓存 60s」
// 换个说法就能在几篇现行文档里各写一个数，而没有任何门禁会因为代码改了而变红。
// 2026-10 实测到的缺口：docs/SETUP.md 的配置表自称默认值「由 test/config.test.mjs
// 与 cordis.patch.yml 双向钉住」，但全仓没有一个测试读 docs/SETUP.md——那份表是
// CONFIG_DEFAULTS / AUTH_DEFAULTS 的第三份副本，改代码只会让用户照着过期文档配出
// 一个装不上的插件。小浣熊的余额/目录 TTL 与路由 body 上限同样以散文形式散着。
//
// 本检查做三件事：
//   A) SETUP.md 配置表 ↔ CONFIG_DEFAULTS / AUTH_DEFAULTS（逐行比值 + 双向闭合）；
//   B) 余额 / 目录缓存 TTL ↔ raccoon-status.ts（全文扫，新写的副本也跑不掉）；
//   C) 路由 body 上限（4 KB / 2 KB）↔ routes/http.ts。
// 源码一律用文本正则读，不 import 宿主模块——本文件要保持 peer-free、干净检出可跑。
{
  const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");
  const relOf = (f) => f.slice(ROOT.length + 1).replace(/\\/g, "/");
  // 从 `export const X = Object.freeze({` 起到第一个 `\n});` 之间的字面量块。
  const blockOf = (text, head) => {
    const at = text.indexOf(head);
    if (at < 0) return null;
    const rest = text.slice(at + head.length);
    const end = rest.indexOf("\n});");
    return end < 0 ? null : rest.slice(0, end);
  };
  // 块里每个键独占一行 `  key: value,`；返回右侧原文（去掉行尾逗号）。
  const rawOf = (block, key) => {
    if (block === null) return undefined;
    const m = block.match(new RegExp(`\\n  ${key}: ([^\\n]*)(?:\\n|$)`));
    return m ? m[1].replace(/,\s*$/, "") : undefined;
  };
  const literal = (raw) => {
    if (raw === undefined) return undefined;
    const s = raw.trim();
    if (/^".*"$/.test(s)) return JSON.parse(s);
    if (s === "true" || s === "false") return s === "true";
    if (/^\d[\d_]*$/.test(s)) return Number(s.replace(/_/g, ""));
    return JSON.parse(s);
  };
  const constNumber = (text, name) => {
    const m = text.match(new RegExp(`export const ${name} = ([\\d_]+)`));
    return m ? Number(m[1].replace(/_/g, "")) : undefined;
  };
  // 源码值 → 文档表格里应有的那一格（去掉反引号后逐字相等）。
  const docText = (v) => {
    if (typeof v === "string") return v === "" ? '""' : v;
    if (v !== null && typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  const cfgBlock = blockOf(readSrc("src/host/host-config.ts"), "export const CONFIG_DEFAULTS = Object.freeze({");
  const authBlock = blockOf(readSrc("src/host/auth-config.ts"), "export const AUTH_DEFAULTS = Object.freeze({");
  const cfg = (k) => literal(rawOf(cfgBlock, k));
  const auth = (k) => literal(rawOf(authBlock, k));

  // --- A) SETUP.md 配置表 ↔ CONFIG_DEFAULTS / AUTH_DEFAULTS ---
  const setup = readSrc("docs/SETUP.md").split(/\r?\n/);
  const headAt = setup.findIndex((l) => /^\|\s*字段\s*\|\s*默认\s*\|\s*说明\s*\|/.test(l));
  const rows = new Map();
  if (headAt < 0) bad("docs/SETUP.md 找不到配置表头「| 字段 | 默认 | 说明 |」——检查 17 失去了看守对象");
  else {
    for (let i = headAt + 2; i < setup.length; i++) {
      if (!setup[i].startsWith("|")) break;
      const m = setup[i].match(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/);
      if (!m) { bad(`docs/SETUP.md:${i + 1} 配置表有一行解析不出来（期望 | \`字段\` | \`默认\` | 说明 |）：${setup[i].slice(0, 40)}…`); continue; }
      rows.set(m[1], { value: m[2], desc: m[3], line: i + 1 });
    }
  }

  // 表字段 → 取值来源。`auth:` 指 AUTH_DEFAULTS（SETUP.md 声明 auth 类留空即用平台默认），
  // `special:` 是「默认值来自别的字段」的两行，单独断言它们声明的关系仍然成立。
  const TABLE = [
    ["consoleBase", "cfg:consoleBase"],
    ["trendHours", "cfg:trendHours"],
    ["trendMultipliers", "cfg:trendMultipliers"],
    ["cacheSeconds", "cfg:cacheSeconds"],
    ["pollSeconds", "cfg:pollSeconds"],
    ["allowedHosts", "special:allowedHosts"],
    ["tokenSkewSeconds", "cfg:tokenSkewSeconds"],
    ["apiBase", "cfg:apiBase"],
    ["iamBase", "auth:iamOrigin"],
    ["tokenEndpoint", "auth:tokenEndpoint"],
    ["jwksEndpoint", "auth:jwksEndpoint"],
    ["redirectUri", "special:redirectUri"],
    ["clientId", "auth:clientId"],
    ["scope", "auth:scope"],
    ["encKeyId", "auth:encKeyId"],
    ["maxHops", "auth:maxHops"],
    ["loginTimeoutMs", "auth:requestTimeoutMs"],
    ["consoleTimeoutMs", "cfg:consoleTimeoutMs"],
    ["writeImageModelIds", "cfg:writeImageModelIds"],
    ["registerProvider", "cfg:registerProvider"],
    ["maxTokensOverrides", "cfg:maxTokensOverrides"],
    ["drawEnabled", "cfg:drawEnabled"],
    ["drawModelId", "cfg:drawModelId"],
    ["drawTimeoutMs", "cfg:drawTimeoutMs"],
    ["providerRefreshMinutes", "cfg:providerRefreshMinutes"],
    ["webSearchEnabled", "cfg:webSearchEnabled"]
  ];

  let compared = 0;
  for (const [field, ref] of TABLE) {
    const row = rows.get(field);
    if (!row) {
      bad(`docs/SETUP.md 配置表缺 \`${field}\` 一行——它的默认值由 ${ref} 提供，删掉这一行等于让操作员失去唯一的人读出处`);
      continue;
    }
    const cell = row.value.replace(/`/g, "").trim();
    if (ref === "special:allowedHosts") {
      const defaults = row.desc.match(/（默认 (.+?)，只增不替/);
      const hosts = defaults ? [...defaults[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
      const codeHosts = cfg("admittedHosts");
      if (cell !== "—") bad(`docs/SETUP.md:${row.line} \`allowedHosts\` 默认格写的是 \`${cell}\`——该字段只增不替，默认格应为「—」，默认主机名列在说明里`);
      if (!Array.isArray(codeHosts)) bad("docs.test.mjs 检查 17：CONFIG_DEFAULTS.admittedHosts 取不到，allowedHosts 一行失去看守对象");
      else if (hosts.join(",") !== codeHosts.join(",")) bad(`docs/SETUP.md:${row.line} \`allowedHosts\` 说明里的默认主机 ${JSON.stringify(hosts)} 与 CONFIG_DEFAULTS.admittedHosts ${JSON.stringify(codeHosts)} 不一致——数值副本已漂移`);
      continue;
    }
    if (ref === "special:redirectUri") {
      const authText = readSrc("src/host/auth-config.ts");
      const keepsRelation = /redirectUri: checkEndpoint\(pick\("redirectUri", consoleOrigin/.test(authText);
      if (cell !== "同 consoleBase") bad(`docs/SETUP.md:${row.line} \`redirectUri\` 默认格写的是 \`${cell}\`，代码里它默认取 consoleOrigin（即 consoleBase）——表述与实现不一致`);
      if (!keepsRelation) bad(`docs/SETUP.md:${row.line} 写 \`redirectUri\` 默认「同 consoleBase」，但 src/host/auth-config.ts 里它的默认来源已不是 consoleOrigin——这一行的表述需要重写`);
      else if (auth("consoleOrigin") !== cfg("consoleBase")) bad(`\`redirectUri\` 默认「同 consoleBase」，但 AUTH_DEFAULTS.consoleOrigin = ${JSON.stringify(auth("consoleOrigin"))} 与 CONFIG_DEFAULTS.consoleBase = ${JSON.stringify(cfg("consoleBase"))} 已经不同`);
      continue;
    }
    const [kind, key] = ref.split(":");
    const v = kind === "auth" ? auth(key) : cfg(key);
    if (v === undefined) {
      bad(`docs.test.mjs 检查 17：${ref} 取不到值——\`${field}\` 这一行的看守对象消失，本检查已失效`);
      continue;
    }
    const want = docText(v);
    compared++;
    if (cell !== want) bad(`docs/SETUP.md:${row.line} \`${field}\` 默认值写的是 \`${cell}\`，源码 ${ref} = \`${want}\`——数值副本已漂移（改默认值为什么不顺手改这一行？）`);
  }
  const specFields = new Set(TABLE.map(([f]) => f));
  for (const [field, row] of rows) {
    if (specFields.has(field)) continue;
    bad(`docs/SETUP.md:${row.line} 配置表的 \`${field}\` 没有登记进 test/docs.test.mjs 检查 17 的取值规格——新增/改名的行必须同时接上看守，否则它又是一份无门禁副本`);
  }
  if (rows.size < 20) bad(`docs/SETUP.md 配置表只解析到 ${rows.size} 行——扫描没够到输入（表被删或改写），这一轮什么都没验到`);
  note(`SETUP.md 配置表 ↔ 源码默认值：${compared} 行逐字比值、表内 ${rows.size} 行（规格 ${TABLE.length} 行）`);

  // drawTimeoutMs 的区间是代码里的硬夹取（resolveDrawTimeoutMs），文档只写一半
  // 就会漂：两个边界都在源码里，说明格必须同时写出，否则操作员按文档配出来的
  // 值与实际生效的值对不上——而默认格只对默认值，这一格没有任何门禁替它比对。
  {
    const row = rows.get("drawTimeoutMs");
    const src = readSrc("src/host/host-config.ts");
    const min = constNumber(src, "DRAW_TIMEOUT_MIN_MS");
    const max = constNumber(src, "DRAW_TIMEOUT_MAX_MS");
    if (!min || !max) bad("检查 17：host-config.ts 的 DRAW_TIMEOUT_MIN_MS / DRAW_TIMEOUT_MAX_MS 取不到——drawTimeoutMs 的区间失去看守对象");
    else if (!row) bad("检查 17：SETUP.md 配置表缺 drawTimeoutMs 行");
    else {
      const nums = [...new Set([...row.desc.matchAll(/\b\d{3,}\b/g)].map((m) => Number(m[0])))];
      if (!nums.includes(min)) bad(`SETUP.md:${row.line} 的 drawTimeoutMs 说明里没有下限 ${min}——源码夹取的下限必须写出来`);
      if (!nums.includes(max)) bad(`SETUP.md:${row.line} 的 drawTimeoutMs 说明里没有上限 ${max}——源码夹取的上限必须写出来`);
      else if (nums.length !== 2) bad(`SETUP.md:${row.line} 的 drawTimeoutMs 说明里有 ${nums.length} 个三位以上数字 ${JSON.stringify(nums)}——只应有两个（下限 ${min} 与上限 ${max}），多出来的多半是漂移的旧副本`);
    }
  }

  // 表里那 9 行 auth 字段写的是**生效值**（来自 AUTH_DEFAULTS），而 CONFIG_DEFAULTS.auth
  // 只是「留空即用平台默认」的形状。上面对的是前者的值，这里补上后者的前提：一旦有人
  // 把某个 auth 覆盖填成具体值，生效默认就换了宿主，而表还写着旧数——只查 AUTH_DEFAULTS
  // 看不出来。SETUP.md 自己写着「auth 类字段留空即表示使用平台默认」，这里是它的可执行版。
  const authShape = (cfgBlock || "").split("auth: {")[1]?.split("},")[0] ?? "";
  const UNSET = [...authShape.matchAll(/^\s+([A-Za-z]+): ([^,\n]+),?\s*$/gm)].map((m) => [m[1], m[2].trim()]);
  if (!UNSET.length) bad("docs.test.mjs 检查 17：CONFIG_DEFAULTS.auth 子块取不到键——auth 字段的「留空 = 用平台默认」前提失去看守对象");
  else {
    let sentinels = 0;
    for (const [key, raw] of UNSET) {
      if (raw === '""' || raw === "0") { sentinels++; continue; }
      bad(`src/host/host-config.ts 的 CONFIG_DEFAULTS.auth.${key} = ${raw}，不再是「留空即用平台默认」的哨兵值——SETUP.md 那一列写的是 AUTH_DEFAULTS 的生效值，覆盖默认一落地它就不再成立，请同步改文档与检查 17`);
    }
    note(`CONFIG_DEFAULTS.auth 留空哨兵：${sentinels}/${UNSET.length} 键仍为 ""/0（SETUP 的 auth 列因此等于 AUTH_DEFAULTS 生效值）`);
  }

  // --- B) 小浣熊缓存 TTL：文档全文的「余额 Ns / 目录 Ns」↔ raccoon-status.ts ---
  const statusSrc = readSrc("src/host/raccoon-status.ts");
  const BAL = constNumber(statusSrc, "RACCOON_BALANCE_TTL_MS");
  const CAT = constNumber(statusSrc, "RACCOON_CATALOG_TTL_MS");
  if (!BAL || !CAT || BAL % 1000 || CAT % 1000) {
    bad("docs.test.mjs 检查 17：raccoon-status.ts 里取不到整数秒的 RACCOON_BALANCE_TTL_MS / RACCOON_CATALOG_TTL_MS——TTL 副本失去看守对象（常量改名或改成非整秒时，同步更新这里）");
  } else {
    const balS = BAL / 1000;
    const catS = CAT / 1000;
    let balHits = 0;
    let catHits = 0;
    for (const f of mdFiles) {
      if (FROZEN_DOCS.has(basename(f)) || f.includes("sensenova-api-reference")) continue;
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/余额[^0-9\n]{0,6}(\d+)\s*?s/g)) {
          balHits++;
          if (Number(m[1]) !== balS) bad(`${relOf(f)}:${i + 1} 余额缓存 TTL 写的是 ${m[1]}s，而 raccoon-status.ts 的 RACCOON_BALANCE_TTL_MS = ${BAL}（${balS}s）`);
        }
        for (const m of line.matchAll(/目录[^0-9\n]{0,6}(\d+)\s*?s/g)) {
          catHits++;
          if (Number(m[1]) !== catS) bad(`${relOf(f)}:${i + 1} 目录缓存 TTL 写的是 ${m[1]}s，而 raccoon-status.ts 的 RACCOON_CATALOG_TTL_MS = ${CAT}（${catS}s）`);
        }
      });
    }
    if (!balHits) bad("docs/ 里扫不到任何「余额 N s」——措辞变了或副本被删，本检查失去看守对象，请核对正则");
    if (!catHits) bad("docs/ 里扫不到任何「目录 N s」——同上");
    note(`小浣熊缓存 TTL 副本：余额 ${balHits} 处 / 目录 ${catHits} 处，全部等于源码常量（${balS}s / ${catS}s）`);
  }

  // --- C) 路由 body 上限：文档里的 4 KB / 2 KB ↔ routes/http.ts ---
  const httpSrc = readSrc("src/host/routes/http.ts");
  const ACC = constNumber(httpSrc, "MAX_ACCOUNT_BODY_BYTES");
  const RAC = constNumber(httpSrc, "MAX_RACCOON_BODY_BYTES");
  if (!ACC || !RAC || ACC % 1024 || RAC % 1024) {
    bad("docs.test.mjs 检查 17：routes/http.ts 里取不到 KB 整数倍的 MAX_ACCOUNT_BODY_BYTES / MAX_RACCOON_BODY_BYTES——文档用 KB 表述，常量改动时必须同步这里");
  } else {
    // 每条 = 定位行（必须唯一命中，否则锚点失效）+ 该行里取数的正则 + 期望 KB + 人事描述。
    const BODY = [
      ["docs/API.md", /Token Plan 路由的请求体上限/, /请求体上限 \*\*(\d+) KB\*\*/, ACC / 1024, "Token Plan 路由 body 上限"],
      ["docs/API.md", /第 7 节）的 POST 上限/, /自己的 \*\*(\d+) KB\*\*/, RAC / 1024, "小浣熊 POST body 上限"],
      ["docs/API.md", /JSON 数组、超/, /超 (\d+) KB/, ACC / 1024, "account 非法 body 分支的阈值"],
      ["docs/API.md", /按 body 的 `action` 分发/, /请求体上限 \*\*(\d+) KB\*\*/, RAC / 1024, "小浣熊路由 body 上限"],
      ["docs/DSH-PLUGIN.md", /POST 校验 body ≤/, /≤ (\d+)KB/, ACC / 1024, "DSH-PLUGIN 里的 account body 上限"]
    ];
    let hit = 0;
    for (const [file, where, re, want, label] of BODY) {
      const lines = readSrc(file).split(/\r?\n/);
      const at = lines.map((l, i) => (where.test(l) ? i : -1)).filter((i) => i >= 0);
      if (at.length !== 1) {
        bad(`${file} 里匹配「${where.source}」的行有 ${at.length} 行（期望 1）——${label} 的锚点失效，请更新检查 17 的定位正则`);
        continue;
      }
      const m = lines[at[0]].match(re);
      if (!m) {
        bad(`${file}:${at[0] + 1} 找不到 ${label} 的数值（正则 ${re.source} 未命中）——副本被改写，本检查失去看守对象`);
        continue;
      }
      hit++;
      if (Number(m[1]) !== want) bad(`${file}:${at[0] + 1} ${label} 写的是 ${m[1]} KB，而 routes/http.ts 的常量 = ${want * 1024} 字节（${want} KB）`);
    }
    note(`路由 body 上限副本：${hit}/${BODY.length} 处定位成功并等于源码常量（${ACC / 1024} KB / ${RAC / 1024} KB）`);
  }

  // --- D) client 面板的回退字面量 ↔ CONFIG_DEFAULTS ---
  // The trend card quotes the cache age from the SNAPSHOT, not from a local
  // literal (see the comment at src/client/panel-page.ts). The `?? 60` /
  // `?? 24` there are backstops for a snapshot that stops carrying the
  // fields; that comment already declares them lies and says the fix is to
  // DROP the fallbacks, never to retune the numbers. This sub-check pins the
  // backstops to CONFIG_DEFAULTS, so a Host default change trips the gate
  // instead of silently retuning what the panel would show if the contract
  // ever breaks.
  const clientSrc = readSrc("src/client/panel-page.ts");
  const bsCache = (clientSrc.match(/data\?\.cacheSeconds \?\? (\d+)/) || [])[1];
  const bsHours = (clientSrc.match(/trend\?\.hours \?\? (\d+)/) || [])[1];
  if (bsCache === undefined || bsHours === undefined) {
    bad("docs.test.mjs 检查 17：src/client/panel-page.ts 找不到趋势卡的 cacheSeconds / hours 回退字面量——D) 失去看守对象，请核对 `?? 60` / `?? 24` 那两行是否被改写");
  } else {
    const wantCache = cfg("cacheSeconds");
    const wantHours = cfg("trendHours");
    if (Number(bsCache) !== wantCache)
      bad(`src/client/panel-page.ts 趋势卡回退 cache = ${bsCache}，但 CONFIG_DEFAULTS.cacheSeconds = ${wantCache}——回退字面量已漂移（该卡注释明写：fix 是 drop the fallback，不是 retune the numbers）`);
    if (Number(bsHours) !== wantHours)
      bad(`src/client/panel-page.ts 趋势卡回退 hours = ${bsHours}，但 CONFIG_DEFAULTS.trendHours = ${wantHours}——回退字面量已漂移`);
    if (Number(bsCache) === wantCache && Number(bsHours) === wantHours)
      note(`client 趋势卡回退字面量 ↔ CONFIG_DEFAULTS：cache ${bsCache} / hours ${bsHours}`);
  }
}

if (fails.length) {
  console.error(`\n❌ docs.test.mjs 失败 ${fails.length} 项：`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ docs.test.mjs 全部通过\n");
