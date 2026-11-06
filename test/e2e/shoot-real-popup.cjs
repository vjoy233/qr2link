/**
 * shoot-real-popup.cjs — 真实工具栏弹窗像素截图（单连接内：唤醒 SW → openPopup → 立即 attach 截屏）
 * 前置：浏览器带 --remote-debugging-port 且已加载新 zip 解压目录的扩展（英文 UI）
 * 用法：NODE_PATH="$(npm root -g)" node shoot-real-popup.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pw = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9223');
  const cdp = await browser.newBrowserCDPSession();
  const context = browser.contexts()[0];

  const all1 = (await cdp.send('Target.getTargets')).targetInfos;
  console.log('targets:', all1.map((t) => `${t.type}|${t.url.slice(0, 60)}`).join('  '));
  const before = new Set(all1.map((t) => t.targetId));
  const knownPopup = all1.filter((t) => t.url.includes('popup.html')).map((t) => t.targetId);

  // 前置说明：真实弹窗由 computer use 点击工具栏打开（同时唤醒 SW）；
  // 本脚本在弹窗存活期内 attach。若未见弹窗 target，尝试 SW openPopup 兜底。
  let popup = all1.find((t) => t.url.includes('popup.html') && !isStale(t)) || null;
  function isStale(_t) { return knownPopup.length > 0 && false; } // 占位：knownPopup 为空时任何 popup target 均可用

  if (!popup) {
    const ours = all1.find((t) => /\/background\.js$/.test(t.url));
    if (!ours) throw new Error('无弹窗 target 且无我们的 SW（先由 computer use 打开弹窗，或稍后重试）');
    const swUrl = ours.url;
    console.log('SW:', swUrl);
    let sw = context.serviceWorkers().find((w) => w.url() === swUrl);
    if (!sw) throw new Error('SW target 存在但 Playwright 未绑定（SW 可能已挂起）');
    await sw.evaluate(() => chrome.action.openPopup());
    for (let i = 0; i < 40 && !popup; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      popup = targetInfos.find((t) => t.url.includes('popup.html') && !knownPopup.includes(t.targetId));
      if (!popup) await sleep(150);
    }
  }
  if (!popup) throw new Error('popup target 未出现');
  console.log('popup target:', popup.targetId, popup.url);

  // 3. 立即 attach + 截屏 + dump（弹窗存活期内完成）
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const out = path.join(__dirname, 'report', 'real-popup-en-zip.png');
  fs.writeFileSync(out, Buffer.from(data, 'base64'));

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({lang: document.documentElement.lang, ui: chrome.i18n.getUILanguage(), texts: [...document.querySelectorAll('[data-i18n]')].map(el => el.getAttribute('data-i18n') + ' => ' + (el.textContent||'').trim())})`,
    returnByValue: true,
  }, sessionId);
  const info = JSON.parse(result.value);
  console.log(`ui=${info.ui} htmlLang=${info.lang}`);
  info.texts.forEach((l) => console.log('  ' + l));
  console.log('截图:', out, `(${data.length} bytes)`);
  browser.close(); // 仅断开
}

main().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
