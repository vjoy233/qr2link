/** probe-load.cjs — 检查各 channel 下 --load-extension 是否真正生效（读 chrome://extensions DOM） */
'use strict';
const { pw, EXT_DIR } = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function probe(channel) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qr2link-probe-${channel}-QR2LINK-E2E-MARKER-`));
  let context;
  try {
    context = await pw.chromium.launchPersistentContext(userDataDir, {
      channel,
      headless: false,
      viewport: null,
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-first-run', '--no-default-browser-check', '--window-size=1100,800',
      ],
    });
    await new Promise((r) => setTimeout(r, 3000));
    const sws = context.serviceWorkers().map((w) => w.url());
    console.log(`[${channel}] service workers:`, JSON.stringify(sws));

    const page = await context.newPage();
    const url = channel === 'msedge' ? 'edge://extensions' : 'chrome://extensions';
    try {
      await page.goto(url, { timeout: 8000 });
    } catch (e) {
      console.log(`[${channel}] goto ${url} failed: ${e.message.split('\n')[0]}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const info = await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager') || document.querySelector('extensions-manager, cr-view');
      // 穿 shadow root 收集条目
      const names = [];
      const devMode = [];
      try {
        const root1 = document.querySelector('extensions-manager').shadowRoot;
        const toolbar = root1.querySelector('extensions-toolbar');
        const toggle = toolbar && toolbar.shadowRoot && toolbar.shadowRoot.querySelector('#devMode');
        if (toggle) devMode.push(`devMode.checked=${toggle.checked}`);
        const list = root1.querySelector('extensions-item-list');
        if (list && list.shadowRoot) {
          list.shadowRoot.querySelectorAll('extensions-item').forEach((it) => {
            const r = it.shadowRoot;
            const name = r.querySelector('#name');
            names.push(name ? name.textContent.trim() : it.id);
          });
        }
      } catch (e) { names.push('ERR:' + e.message); }
      return { names, devMode };
    });
    console.log(`[${channel}] extensions listed:`, JSON.stringify(info));
  } catch (e) {
    console.log(`[${channel}] FAIL:`, e.message.split('\n')[0]);
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

(async () => {
  await probe('chrome');
  await probe('msedge');
  await probe('chromium'); // Playwright 自建 Chromium（非品牌版）
})().catch((e) => { console.error(e); process.exit(1); });
