/**
 * probe-lang.cjs — i18n 语言匹配探针（I18N-PLAN §4.8-4：e2e 断言改造的前置验证）
 *
 * 逐一以 --lang={zh-CN, en-US, fr} 启动浏览器，读 SW 侧：
 *   - chrome.i18n.getUILanguage()       → --lang 是否真的翻转 UI 语言
 *   - getMessage('menu_scan_image')     → 语言包命中（zh-CN→简中 / en-US→英文 / fr→default=en 回落）
 *   - getManifest().description         → manifest __MSG_ 解析链路
 *
 * 用法：NODE_PATH="$(npm root -g)" node probe-lang.cjs <msedge|chromium>
 */
'use strict';
const { launch } = require('./helpers.cjs');

async function main() {
  const channel = process.argv[2] || 'chromium';
  for (const lang of ['zh-CN', 'en-US', 'fr']) {
    const h = await launch({ channel, lang });
    try {
      const r = await h.sw.evaluate(() => ({
        ui: chrome.i18n.getUILanguage(),
        menu: chrome.i18n.getMessage('menu_scan_image'),
        desc: chrome.runtime.getManifest().description,
        localeLang: chrome.i18n.getMessage('locale_lang'),
      }));
      console.log(`--lang=${lang.padEnd(5)} → ui=${r.ui}  locale_lang=${r.localeLang}  menu=${r.menu}  desc=${r.desc}`);
    } finally {
      await h.close();
    }
  }
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
