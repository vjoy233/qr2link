/**
 * probe-zipflow.cjs — 发布包端到端探针：从「解压后的目录」加载扩展并 dump 英文 UI
 * 用于复现用户报告（zip 反斜杠条目 → 部分工具解压后 _locales 缺失 → 按钮 raw key）
 * 用法：NODE_PATH="$(npm root -g)" node probe-zipflow.cjs <扩展目录绝对路径> [标签]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const pw = require('playwright');

async function main() {
  const extDir = process.argv[2];
  const tag = process.argv[3] || path.basename(extDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr2link-zipflow-'));
  const context = await pw.chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: false, viewport: null,
    args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir, '--lang=en-US', '--no-first-run'],
  });
  try {
    let sw = context.serviceWorkers().find((w) => w.url().endsWith('background.js'));
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    console.log(`[${tag}] SW: ${sw ? '已加载 ' + sw.url() : '未出现（Chrome 拒绝加载）'}`);

    const extId = sw ? new URL(sw.url()).host : null;
    if (!extId) return;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.waitForSelector('#view-home', { state: 'visible', timeout: 5000 });
    const texts = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-i18n]')) {
        out.push(`${el.getAttribute('data-i18n')} => "${(el.textContent || '').trim()}"`);
      }
      return out;
    });
    console.log(`[${tag}] data-i18n 渲染:`);
    texts.forEach((t) => console.log('  ' + t));
    const mf = await page.evaluate(() => chrome.runtime.getManifest().description);
    console.log(`[${tag}] manifest description: "${mf}"`);
    await page.screenshot({ path: path.join(__dirname, 'report', `zipflow-${tag}.png`), fullPage: true });
    console.log(`[${tag}] 截图: test/e2e/report/zipflow-${tag}.png`);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
