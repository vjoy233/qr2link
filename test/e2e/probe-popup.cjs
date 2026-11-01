/**
 * probe-popup.cjs — 真实 popup 自动化可行性探测：
 *   1. openPopup() 后 CDP Target.getTargets 里是否有 popup target（Playwright 不 attach ≠ 不存在）
 *   2. openPopup 是否授予 activeTab（SW 能否 captureVisibleTab 成功 → 真实主路径能否全自动）
 *   3. 若 target 存在：尝试 raw CDP attach + Runtime.evaluate
 */
'use strict';
const { launch, serveStatic, sleep } = require('./helpers.cjs');

async function main() {
  const channel = process.argv[2] || 'msedge';
  const srv = await serveStatic(require('./helpers.cjs').TEST_DIR);
  let h;
  try {
    h = await launch({ channel });
    // 先开一个测试页作为底页
    const testPage = await h.context.newPage();
    await testPage.goto(`${srv.url}/index.html`);
    await testPage.bringToFront();

    const rp = { called: false, err: null };
    try { await h.sw.evaluate(() => chrome.action.openPopup()); rp.called = true; }
    catch (e) { rp.err = e.message.split('\n')[0]; }
    console.log('openPopup called:', rp.called, rp.err || '');
    await sleep(2500);

    // 1. CDP 层看全部 targets
    const browser = h.context.browser();
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const interesting = targetInfos.filter((t) => /extension|popup/i.test(t.url) || t.type !== 'page');
    console.log('targets:', JSON.stringify(interesting.map((t) => ({ type: t.type, url: t.url.slice(0, 90) })), null, 1));

    // 2. openPopup 是否授予 activeTab → SW 能否截图
    const cap = await h.sw.evaluate(() =>
      chrome.tabs.captureVisibleTab(null, { format: 'png' })
        .then((d) => `SUCCESS ${d.length} bytes`, (e) => `FAIL: ${e.message}`));
    console.log('SW captureVisibleTab after openPopup:', cap);

    // 3. 尝试手动 attach popup target
    const popupTarget = targetInfos.find((t) => t.url.includes('popup.html'));
    if (popupTarget) {
      console.log('popup target found:', popupTarget.targetId, popupTarget.url);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
      const ev = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({href:location.href,mode:document.body.dataset.mode})', sessionId });
      console.log('raw CDP evaluate in popup:', ev.result.value);
    } else {
      console.log('no popup target exists at CDP level');
    }
  } finally {
    if (h) await h.close();
    await srv.close();
  }
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
