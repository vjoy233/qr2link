/**
 * probe-en-ui.cjs — 英文 UI 全表面探针（用户报告：英文界面部分按钮显示原始 key 名）
 *
 * 对 chromium / msedge 各以 en-US 启动：
 *   - dump popup 全部 data-i18n 节点渲染文本 + 识别「疑似原始 key」文本
 *   - getUILanguage / getMessage 抽样 / html lang
 *   - popup 截图留档
 *   - chrome.action.openPopup() 开真实弹窗（可 attach 时）做同样 dump + 截图
 * 用法：NODE_PATH="$(npm root -g)" node probe-en-ui.cjs
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { launch, openPopupTab, tryOpenRealPopup, sleep } = require('./helpers.cjs');

const OUT = path.join(__dirname, 'report');

function dumpPage(page) {
  return page.evaluate(() => {
    const nodes = [], raw = [];
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const key = el.getAttribute('data-i18n');
      const txt = (el.textContent || '').trim();
      nodes.push(`${key} => "${txt}"`);
      // 原始 key 特征：纯标识符（camel 大写或 snake 下划线）且无空格 —— 正常文案必有空格/中文/纯词
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(txt) && /[A-Z_]/.test(txt)) raw.push(`${key} => "${txt}"`);
    }
    return {
      ui: chrome.i18n.getUILanguage(),
      htmlLang: document.documentElement.lang,
      sample: {
        menu: chrome.i18n.getMessage('menu_scan_image'),
        btnScreenshot: chrome.i18n.getMessage('btn_screenshot'),
        btnUploadSub: chrome.i18n.getMessage('btn_upload_sub'),
      },
      nodes, raw,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const channel of ['chromium', 'msedge']) {
    console.log(`\n========== ${channel} × en-US ==========`);
    const h = await launch({ channel, lang: 'en-US' });
    try {
      const page = await openPopupTab(h);
      const info = await dumpPage(page);
      console.log(`ui=${info.ui}  htmlLang=${info.htmlLang}`);
      console.log(`getMessage 抽样: ${JSON.stringify(info.sample)}`);
      info.nodes.forEach((n) => console.log(`  ${n}`));
      console.log(info.raw.length ? `!! 疑似原始 key 渲染: ${info.raw.join(' | ')}` : 'data-i18n 渲染无原始 key');
      await page.screenshot({ path: path.join(OUT, `en-ui-${channel}-tab.png`), fullPage: true });

      const rp = await tryOpenRealPopup(h);
      if (rp.page) {
        await sleep(400);
        const real = await dumpPage(rp.page);
        console.log(`真实弹窗: ui=${real.ui} raw=${real.raw.length ? real.raw.join(' | ') : '无'}`);
        await rp.page.screenshot({ path: path.join(OUT, `en-ui-${channel}-real.png`), fullPage: true }).catch(() => {});
      } else {
        console.log(`真实弹窗不可 attach（${rp.error}），跳过`);
      }
    } finally {
      await h.close();
    }
  }
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
