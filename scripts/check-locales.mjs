/**
 * scripts/check-locales.mjs — _locales 完整性静态校验（零浏览器依赖）
 * 用法：node scripts/check-locales.mjs [--self-test]
 *
 * 守门场合（I18N-PLAN §4.7 / grill Q3）：run-all.cjs 第 0 步强制执行 + 发版清单。
 * 校验（任一失败非零退出）：
 *   1. en 与 zh_CN 的 key 集合完全一致
 *   2. 无重复 key（字符串感知的原始文本扫描，不依赖排版）、message 非空
 *   3. i18n.js 的 KEYS 与 locale key 双向一致（manifest 专用 key 除外）
 *   4. 引用闭包：popup.html data-i18n（任意取值格式，先收集后校验）⊆ KEYS；
 *      JS 侧 T.x / I18N.x / self.I18N.x ⊆ KEYS；manifest __MSG_ token 可解析；
 *      default_locale 的值必须有对应 _locales 目录
 *
 * --self-test：对守门自身做变异测试（同行重复 key / snake_case 绑定 / key 拼写 /
 *   default_locale 无语言包 / 正常基线），全部按预期捕获才通过
 *  （PR #3 AIbot review P2×2 + P3 采纳项的回归锁定）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// manifest 专用 key：只经 __MSG_ 引用，不进 i18n.js KEYS
const MANIFEST_ONLY = ['manifest_description', 'command_scan_description'];

// ---- 字符串感知的顶层 key 扫描 ----
// 逐字符状态机：跟踪引号/转义/花括号深度，收集「深度 1 处、后随 ':' 的字符串」为根对象
// 成员名（含重复）。与排版无关——压缩/同行/任意空白形态的重复 key 均可捕获，
// 弥补 JSON.parse 对重复属性静默取后者、行首正则依赖格式化的两个盲区。
function scanRootKeys(text) {
  const keys = [];
  let depth = 0, inStr = false, esc = false, buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; buf += c; continue; }
      if (c === '\\') { esc = true; buf += c; continue; }
      if (c === '"') {
        inStr = false;
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (depth === 1 && text[j] === ':') keys.push(buf);
        continue;
      }
      buf += c;
      continue;
    }
    if (c === '"') { inStr = true; buf = ''; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return keys;
}

// ---- 校验主体：overrides 供 --self-test 注入变异内容（不写盘） ----
function runChecks(overrides = {}) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const read = (rel) => (rel in overrides) ? overrides[rel] : fs.readFileSync(path.join(root, rel), 'utf8');

  // ---- 1/2. 两份 messages.json：JSON 合法 + 重复 key（状态机）+ message 非空 ----
  function loadLocale(dir) {
    const rel = `_locales/${dir}/messages.json`;
    let text, data;
    try {
      text = read(rel);
      data = JSON.parse(text);
    } catch (e) {
      fail(`${rel} 不是合法 JSON：${e.message}`);
      return {};
    }
    const names = scanRootKeys(text);
    const dup = names.filter((k, i) => names.indexOf(k) !== i);
    if (dup.length) fail(`${rel} 重复 key（JSON.parse 会静默取后者）：${[...new Set(dup)].join(', ')}`);
    for (const [k, v] of Object.entries(data)) {
      if (!v || typeof v.message !== 'string' || !v.message.trim()) {
        fail(`${rel} 的 ${k} 缺非空 message`);
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
  const expectLocale = new Set([...KEYS.map(snake), ...MANIFEST_ONLY]);
  const dupKeys = KEYS.filter((k, i) => KEYS.indexOf(k) !== i);
  if (dupKeys.length) fail(`i18n.js KEYS 重复：${[...new Set(dupKeys)].join(', ')}`);

  for (const k of expectLocale) if (!enKeys.has(k)) fail(`locale 缺 i18n.js/manifest 引用的 key：${k}`);
  for (const k of enKeys) if (!expectLocale.has(k)) fail(`locale 多出无人引用的 key：${k}（加入 KEYS 或删除）`);

  // ---- 4a. popup.html data-i18n：先收集全部取值（任意格式），再对照 KEYS ----
  // 不能按 key 格式过滤——snake_case 拼写错误同样必须被拒绝而非静默忽略（review P2）
  const html = read('popup/popup.html');
  for (const m of html.matchAll(/data-i18n="([^"]*)"/g)) {
    if (!KEYS.includes(m[1])) fail(`popup.html data-i18n 引用了 KEYS 之外的 key：${JSON.stringify(m[1])}`);
  }

  // ---- 4b. JS 侧 T.x / I18N.x / self.I18N.x ⊆ KEYS ----
  // 计算式访问（T[变量]）静态不可见，实行登记制：仅允许 applyI18n 内 2 处
  // （key 来源是 data-i18n 属性值，已被 4a 全量校验）；新增动态访问必须先在此
  // 登记数量并说明 key 来源，否则守门拒绝（PR #3 AIbot review P2 采纳）
  const COMPUTED_ACCESS_ALLOWLIST = { 'popup/popup.js': 2 };
  for (const f of ['popup/popup.js', 'popup/crop.js', 'background.js']) {
    const src = read(f);
    const computed = (src.match(/\b(?:T|I18N)\s*\[/g) || []).length;
    if (computed !== (COMPUTED_ACCESS_ALLOWLIST[f] || 0)) {
      fail(`${f} 计算式访问点 ${computed} 处 ≠ 登记 ${COMPUTED_ACCESS_ALLOWLIST[f] || 0} 处——动态 key 静态不可校验，请改直接引用或在 ALLOWLIST 登记`);
    }
    for (const m of src.matchAll(/\b(?:T|I18N|self\.I18N)\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      if (!KEYS.includes(m[1])) fail(`${f} 引用了 KEYS 之外的 key：${m[1]}`);
    }
  }

  // ---- 4c. manifest：__MSG_ 可解析 + default_locale 值须有对应语言包目录 ----
  const manifest = read('manifest.json');
  let mf = null;
  try {
    mf = JSON.parse(manifest);
  } catch (e) {
    fail(`manifest.json 不是合法 JSON：${e.message}`);
  }
  if (mf) {
    const hasMsgToken = /__MSG_/.test(manifest);
    if (hasMsgToken && !mf.default_locale) {
      fail('manifest 含 __MSG_ 但缺 default_locale（Chrome 将拒绝加载）');
    }
    // 值校验（review P3）：default_locale 指向不存在的语言包 → 静态检查通过但扩展加载即损
    if (mf.default_locale) {
      const dirs = fs.readdirSync(path.join(root, '_locales'), { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      if (!dirs.includes(mf.default_locale)) {
        fail(`default_locale="${mf.default_locale}" 无对应 _locales 目录（现有：${dirs.join(', ')}）`);
      }
    }
  }
  for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_@$]+)__/g)) {
    if (!(m[1] in en)) fail(`manifest 引用的 __MSG_${m[1]}__ 在 en 中不存在`);
    if (!(m[1] in zh)) fail(`manifest 引用的 __MSG_${m[1]}__ 在 zh_CN 中不存在`);
  }

  return { errors, keyCount: enKeys.size };
}

// ---- 变异测试：守门自身的回归锁定（review 要求的失败用例） ----
function selfTest() {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const enText = read('_locales/en/messages.json');
  const htmlText = read('popup/popup.html');
  const popupText = read('popup/popup.js');
  const mfText = read('manifest.json');

  const cases = [
    {
      name: '同行重复 key（压缩/内联形态）被捕获',
      overrides: { '_locales/en/messages.json': enText.replace('{\n', '{ "app_name": {"message":"DUP"},\n') },
      expect: (errs) => errs.some((e) => e.includes('重复 key') && e.includes('app_name')),
    },
    {
      name: 'snake_case 的 data-i18n 绑定被拒绝（而非被正则忽略）',
      overrides: { 'popup/popup.html': htmlText.replace('data-i18n="btnScreenshot"', 'data-i18n="btn_screenshot"') },
      expect: (errs) => errs.some((e) => e.includes('btn_screenshot')),
    },
    {
      name: 'JS 侧 key 拼写错误被拒绝',
      overrides: { 'popup/popup.js': popupText.replace('T.errFetchImage', 'T.errFetchImagex') },
      expect: (errs) => errs.some((e) => e.includes('errFetchImagex')),
    },
    {
      name: '计算式 T[...] 访问被拒绝（静态闭包不可见）',
      overrides: { 'popup/popup.js': popupText.replace('T.errFetchImage', 'T["errFetchImage"]') },
      expect: (errs) => errs.some((e) => e.includes('计算式')),
    },
    {
      name: 'default_locale 指向不存在的语言包被拒绝',
      overrides: { 'manifest.json': mfText.replace('"default_locale": "en"', '"default_locale": "fr"') },
      expect: (errs) => errs.some((e) => e.includes('default_locale="fr"')),
    },
    {
      name: '正常基线零报错',
      overrides: {},
      expect: (errs) => errs.length === 0,
    },
  ];

  let pass = 0;
  for (const c of cases) {
    const { errors } = runChecks(c.overrides);
    const ok = c.expect(errors);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `（实际错误：${JSON.stringify(errors)}）`}`);
    if (ok) pass++;
  }
  console.log(`self-test：${pass}/${cases.length} 通过`);
  return pass === cases.length;
}

// ---- 入口 ----
if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}
const { errors, keyCount } = runChecks();
for (const e of errors) console.log(`  ✖ ${e}`);
if (errors.length) {
  console.error(`\nlocale 校验失败：${errors.length} 项（详见上方 ✖）`);
  process.exit(1);
}
console.log(`locale 校验通过：${keyCount} key × 2 语言（含 ${MANIFEST_ONLY.length} 个 manifest 专用 key），引用闭包完整`);
