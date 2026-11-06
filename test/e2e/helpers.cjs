/**
 * helpers.cjs — QR2Link Playwright 自动化验收基础设施
 *
 * 用法：NODE_PATH="$(npm root -g)" node <suite>.cjs
 * （全局安装 playwright，借助 NODE_PATH 供 CJS require）
 *
 * 核心能力：
 *   - launch(): 以持久化 context + --load-extension 加载仓库根为未打包扩展
 *   - openPopupTab(): popup 以普通标签页打开（UI 逻辑自动化；无 activeTab 手势）
 *   - tryOpenRealPopup(): SW 调 chrome.action.openPopup() 开真实弹窗并尝试 attach
 *   - serveTestDir(): 本地静态服务器托管 test/（file: 不可靠，统一走 http://127.0.0.1）
 *   - clipboard.ps1: 系统剪贴板置图/置文本/混合/清空（STA PowerShell）
 *   - oskeys.ps1: 找到自动化浏览器窗口 → 前台化 → SendInput 组合键（触发真实 commands）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const pw = require('playwright');

const EXT_DIR = path.resolve(__dirname, '..', '..'); // 仓库根 = 扩展根
const TEST_DIR = path.join(EXT_DIR, 'test');
const REPORT_DIR = __dirname;

// ---------------- 浏览器启动 ----------------

async function launch({ channel = 'chrome', headless = false, lang } = {}) {
  // 目录名含 MARKER：oskeys.ps1 靠它在进程命令行中定位本自动化实例的主窗口，
  // 避免前台化用户自己开着的浏览器。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qr2link-${channel}-QR2LINK-E2E-MARKER-`));
  const context = await pw.chromium.launchPersistentContext(userDataDir, {
    channel,
    headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1360,900',
      // i18n：锁定 UI 语言（缺省 zh-CN，与既有报告/断言一致；en-US 见 I18N-PLAN §4.8）
      `--lang=${lang || uiLang()}`,
      // example.com → 本机 https（见 serveStatic），消除真实网络依赖与 DNS 黑洞
      '--host-resolver-rules=MAP example.com 127.0.0.2',
      '--ignore-certificate-errors',
    ],
  });
  // 离线确定性：example.com 经 --host-resolver-rules 落到本机 https 服务（serveStatic 的
  // 127.0.0.2:443 + 自签证书 + --ignore-certificate-errors）。本机到 example.com 的直连
  // 会被网络黑洞挂起（DNS 解析成功但 TCP 永不返回），且 127.0.0.1:443 已被本机代理占用，
  // 故用 127.0.0.2。验收只关心「以正确 URL 开页」，不关心落地页内容。
  let sw = context.serviceWorkers().find((w) => w.url().endsWith('background.js'));
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 25000 });
    } catch (e) {
      throw new Error(`扩展 Service Worker 未出现（channel=${channel}）：${e.message}`);
    }
  }
  const extId = new URL(sw.url()).host;
  return {
    channel,
    context,
    sw,
    extId,
    userDataDir,
    close: async () => {
      try { await context.close(); } catch (e) { /* 已退出 */ }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// ---------------- 页面辅助 ----------------

/** popup 以普通标签页打开（可完整自动化 UI；无 activeTab 手势，截图按钮走失败路径） */
async function openPopupTab(h) {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.extId}/popup/popup.html`);
  await page.waitForSelector('#view-home', { state: 'visible', timeout: 5000 });
  return page;
}

/**
 * SW 调 chrome.action.openPopup() 开真实弹窗（127+ 可编程调用）。
 * 返回 attach 到的 popup Page；Playwright 若不 attach 扩展 popup target 则返回 null。
 */
async function tryOpenRealPopup(h, { timeoutMs = 4000 } = {}) {
  const before = new Set(h.context.pages().map((p) => p.url()));
  try {
    await h.sw.evaluate(() => chrome.action.openPopup());
  } catch (e) {
    return { page: null, error: `openPopup() 失败: ${e.message.split('\n')[0]}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = h.context.pages();
    const hit = pages.find((p) => p.url().includes('popup.html') && !before.has(p.url()));
    if (hit) {
      await hit.waitForSelector('#view-home', { state: 'visible', timeout: 3000 }).catch(() => {});
      return { page: hit, error: null };
    }
    await sleep(200);
  }
  return { page: null, error: `openPopup() 已调用但 ${timeoutMs}ms 内未出现可 attach 的 popup 页面` };
}

// ---------------- 静态服务器 ----------------

function serveStatic(dir) {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  };
  return new Promise((resolve) => {
    const handler = (req, resp) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let fp = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
      if (!fp.startsWith(dir)) { resp.writeHead(403); resp.end(); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { resp.writeHead(404); resp.end('not found'); return; }
        // ACAO:*：模拟 activeTab 已授予来源（真实场景中右键同源图由 activeTab 放行 fetch）
        resp.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        resp.end(data);
      });
    };
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      // example.com 的离线落点：127.0.0.2:443 自签 https（配合 launch 的 DNS 映射）
      let httpsSrv = null;
      try {
        const certDir = path.join(__dirname, 'cert');
        if (!fs.existsSync(path.join(certDir, 'cert.pem'))) {
          // 自签证书自动生成（example.com 落地 https 用；一次性，已 gitignore）
          fs.mkdirSync(certDir, { recursive: true });
          const { execFileSync: exec } = require('child_process');
          exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(certDir, 'key.pem'),
            '-out', path.join(certDir, 'cert.pem'), '-days', '30', '-nodes',
            '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com'], { stdio: 'ignore' });
        }
        if (fs.existsSync(path.join(certDir, 'cert.pem'))) {
          const https = require('https');
          const opts = {
            key: fs.readFileSync(path.join(certDir, 'key.pem')),
            cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
          };
          httpsSrv = https.createServer(opts, handler);
          httpsSrv.listen(443, '127.0.0.2');
        }
      } catch (e) { console.warn('[warn] https(127.0.0.2:443) 启动失败:', e.message); }
      resolve({
        srv, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise((r) => { srv.close(() => { if (httpsSrv) httpsSrv.close(() => r()); else r(); }); }),
      });
    });
  });
}

// ---------------- PowerShell 系统交互（剪贴板 / OS 按键） ----------------

function psRun(script, args) {
  try {
    execFileSync('powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout: 20000, windowsHide: true });
  } catch (e) {
    throw new Error(`psRun ${path.basename(script)} 失败: ${String((e.stderr && e.stderr.toString()) || e.message).split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 500)}`);
  }
}

/** 置系统剪贴板。mode: image|text|mixed|clear */
function setClipboard(mode, { file = '', text = '' } = {}) {
  psRun(path.join(__dirname, 'clipboard.ps1'), [mode, file, text]);
}

/** 前台化自动化浏览器窗口并注入 OS 级组合键（如 Alt+Shift+S），触发真实 commands 手势 */
function osSendKeys(channel, combo) {
  psRun(path.join(__dirname, 'oskeys.ps1'), [channel, combo]);
}

// ---------------- 小工具 ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- i18n 期望文案（与 launch 的 --lang 同源） ----------------

/** 启动语言：QR2LINK_E2E_LANG（zh-CN | en-US），缺省 zh-CN（锁定既有断言语境） */
function uiLang() { return process.env.QR2LINK_E2E_LANG || 'zh-CN'; }

// 语言 → _locales 目录（Chrome 扩展目录命名用下划线；en 覆盖全部英文变体）
const LANG_DIR = { 'zh-CN': 'zh_CN', 'en-US': 'en' };
const localeCache = Object.create(null);

/** 读 _locales/<dir>/messages.json 的 message 值，断言与 UI 实际文案同源（I18N-PLAN §4.8） */
function msg(key, lang = uiLang()) {
  const dir = LANG_DIR[lang];
  if (!dir) throw new Error(`不支持的 QR2LINK_E2E_LANG=${lang}（可选：${Object.keys(LANG_DIR).join(' / ')}）`);
  if (!localeCache[dir]) {
    localeCache[dir] = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales', dir, 'messages.json'), 'utf8'));
  }
  const hit = localeCache[dir][key];
  if (!hit || typeof hit.message !== 'string') throw new Error(`msg(${key}) 在 _locales/${dir} 不存在`);
  return hit.message;
}

module.exports = {
  pw, EXT_DIR, TEST_DIR, REPORT_DIR,
  launch, openPopupTab, tryOpenRealPopup, serveStatic,
  setClipboard, osSendKeys, sleep,
  uiLang, msg,
};

// ---------------- 附加工具 ----------------

/** 读回系统剪贴板纯文本（验证「复制」按钮） */
function getClipboardText() {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'],
    { timeout: 15000, windowsHide: true, encoding: 'utf8' }).trim();
}
module.exports.getClipboardText = getClipboardText;
