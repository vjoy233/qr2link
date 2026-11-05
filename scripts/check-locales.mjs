/**
 * scripts/check-locales.mjs — _locales 完整性静态校验（零浏览器依赖）
 * 用法：node scripts/check-locales.mjs（或 npm run check:locales）
 *
 * 守门场合（I18N-PLAN §4.7 / grill Q3）：run-all.cjs 第一步强制执行 + 发版清单。
 * 校验四件事，任一失败非零退出：
 *   1. en 与 zh_CN 的 key 集合完全一致
 *   2. 无重复 key、每条 message 为非空字符串
 *   3. i18n.js 的 KEYS 与 locale key 双向一致（manifest 专用 key 除外）
 *   4. 引用闭包：popup.html data-i18n / JS 侧 T.xxx·I18N.xxx ⊆ KEYS；
 *      manifest 的 __MSG_x__ token 均可解析；default_locale 必填
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const errors = [];
const fail = (msg) => { errors.push(msg); console.log(`  ✖ ${msg}`); };

// manifest 专用 key：只经 __MSG_ 引用，不进 i18n.js KEYS
const MANIFEST_ONLY = ['manifest_description', 'command_scan_description'];

// ---- 1/2. 两份 messages.json：重复 key / 非空 message / key 奇偶 ----
// JSON.parse 对重复 key 静默取后者 → 先正则抓顶层 message 名做重名检查
// （文件内唯一对象值即 message 条目，值均为字符串，不会误抓）
function loadLocale(dir) {
  const text = read(`_locales/${dir}/messages.json`);
  const names = [...text.matchAll(/^\s*"([A-Za-z0-9_@$]+)"\s*:\s*\{/gm)].map((m) => m[1]);
  const dup = names.filter((k, i) => names.indexOf(k) !== i);
  if (dup.length) fail(`_locales/${dir} 重复 key：${[...new Set(dup)].join(', ')}`);
  const data = JSON.parse(text);
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v.message !== 'string' || !v.message.trim()) {
      fail(`_locales/${dir} 的 ${k} 缺非空 message`);
    }
  }
  return data;
}

const en = loadLocale('en');
const zh = loadLocale('zh_CN');
const enKeys = new Set(Object.keys(en));
const zhKeys = new Set(Object.keys(zh));

for (const k of enKeys) if (!zhKeys.has(k)) fail(`key 仅 en 有、zh_CN 缺失：${k}`);
for (const k of zhKeys) if (!enKeys.has(k)) fail(`key 仅 zh_CN 有、en 缺失：${k}`);

// ---- 3. i18n.js KEYS ↔ locale key ----
const i18nSrc = read('i18n.js');
const keysBlock = i18nSrc.match(/var KEYS = \[([\s\S]*?)\]/);
const KEYS = keysBlock ? [...keysBlock[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]) : [];
if (!KEYS.length) fail('i18n.js 未能解析出 KEYS 列表');

const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const keySnakes = new Set(KEYS.map(snake));
const dupKeys = KEYS.filter((k, i) => KEYS.indexOf(k) !== i);
if (dupKeys.length) fail(`i18n.js KEYS 重复：${[...new Set(dupKeys)].join(', ')}`);

const expectLocale = new Set([...keySnakes, ...MANIFEST_ONLY]);
for (const k of expectLocale) if (!enKeys.has(k)) fail(`locale 缺 i18n.js/manifest 引用的 key：${k}`);
for (const k of enKeys) if (!expectLocale.has(k)) fail(`locale 多出无人引用的 key：${k}（加入 KEYS 或删除）`);

// ---- 4a. popup.html data-i18n ⊆ KEYS ----
for (const m of read('popup/popup.html').matchAll(/data-i18n="([A-Za-z]+)"/g)) {
  if (!KEYS.includes(m[1])) fail(`popup.html data-i18n 引用了 KEYS 之外的 key：${m[1]}`);
}

// ---- 4b. JS 侧 T.xxx / I18N.xxx / self.I18N.xxx ⊆ KEYS ----
for (const f of ['popup/popup.js', 'popup/crop.js', 'background.js']) {
  const src = read(f);
  for (const m of src.matchAll(/\b(?:T|I18N|self\.I18N)\.([A-Za-z][A-Za-z0-9]*)/g)) {
    if (!KEYS.includes(m[1])) fail(`${f} 引用了 KEYS 之外的 key：${m[1]}`);
  }
}

// ---- 4c. manifest __MSG_x__ 可解析 + default_locale 必填 ----
const manifest = read('manifest.json');
const hasMsgToken = /__MSG_/.test(manifest);
if (hasMsgToken && !/"default_locale"\s*:/.test(manifest)) {
  fail('manifest 含 __MSG_ 但缺 default_locale（Chrome 将拒绝加载）');
}
for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_@$]+)__/g)) {
  if (!(m[1] in en)) fail(`manifest 引用的 __MSG_${m[1]}__ 在 locale 文件中不存在`);
  if (!(m[1] in zh)) fail(`manifest 引用的 __MSG_${m[1]}__ 在 zh_CN 中不存在`);
}

// ---- 汇总 ----
if (errors.length) {
  console.error(`\nlocale 校验失败：${errors.length} 项（详见上方 ✖）`);
  process.exit(1);
}
console.log(`locale 校验通过：${enKeys.size} key × 2 语言（含 ${MANIFEST_ONLY.length} 个 manifest 专用 key），引用闭包完整`);
