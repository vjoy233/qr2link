/**
 * smoke.cjs — 关键未知项探针（不进正式套件）：
 *   1. 品牌版 Chrome 156 是否仍支持 --load-extension（MV3 SW 出现即成功）
 *   2. popup 以标签页打开是否可用
 *   3. chrome.action.openPopup() 是否可从 SW 调用；popup target 是否被 Playwright attach
 *   4. canUseNativeQr 两端真实返回值
 *   5. SW 无手势直接 captureVisibleTab 的报错形态（验证 activeTab 授予模型）
 *   6. 右键菜单注册情况
 */
'use strict';
const { launch, openPopupTab, tryOpenRealPopup, serveStatic, sleep } = require('./helpers.cjs');

async function main() {
  const channel = process.argv[2] || 'msedge';
  const srv = await serveStatic(require('./helpers.cjs').TEST_DIR);
  console.log(`[${channel}] static server:`, srv.url);

  let h;
  try {
    h = await launch({ channel });
    console.log('OK-1 SW loaded, extId =', h.extId);

    // 4. 引擎检测（SW 端只看 BarcodeDetector 存在性；qr.js 仅在 window 上下文引入）
    const nativeSW = await h.sw.evaluate(async () => ({
      hasBD: 'BarcodeDetector' in globalThis,
      i18nOk: typeof self.I18N === 'object' && !!self.I18N.badgeFail,
    }));
    console.log('OK-4 SW env:', JSON.stringify(nativeSW));

    // 6. 右键菜单（Edge 的 contextMenus 无 getAll，仅 chromium 通道可枚举）
    const menus = await h.sw.evaluate(async () => {
      if (chrome.contextMenus && typeof chrome.contextMenus.getAll === 'function') {
        return (await chrome.contextMenus.getAll()).map((m) => ({ id: m.id, contexts: m.contexts }));
      }
      return 'SKIP: Edge contextMenus 无 getAll';
    });
    console.log('OK-6 menus:', JSON.stringify(menus));

    // 2. popup 标签页
    const page = await openPopupTab(h);
    const nativePopup = await page.evaluate(async () => ({
      hasBD: 'BarcodeDetector' in window,
      canUse: await window.QR2Link.canUseNativeQr(),
      mode: document.body.dataset.mode,
    }));
    console.log('OK-2 popup tab open; native check:', JSON.stringify(nativePopup));

    // 5. 无手势 captureVisibleTab（SW 端）
    const capErr = await h.sw.evaluate(() =>
      chrome.tabs.captureVisibleTab(null, { format: 'png' })
        .then(() => 'UNEXPECTED-SUCCESS', (e) => `${e.message}`.split('\n')[0]));
    console.log('OK-5 SW captureVisibleTab without gesture:', capErr);

    // 3. 真实 popup
    const rp = await tryOpenRealPopup(h);
    if (rp.page) {
      const info = await rp.page.evaluate(() => ({
        url: location.href,
        mode: document.body.dataset.mode,
        hasFocus: document.hasFocus(),
      }));
      console.log('OK-3 real popup attached:', JSON.stringify(info));
    } else {
      console.log('OK-3 real popup NOT attachable:', rp.error);
    }
  } finally {
    if (h) await h.close();
    await srv.close();
    console.log('smoke done');
  }
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1); });
