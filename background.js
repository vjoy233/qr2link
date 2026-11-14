/**
 * background.js — Service Worker：快捷键直扫、右键图片识别、offscreen 生命周期（DESIGN §5）
 *
 * 职责边界（DESIGN §3.1）：三大核心入口全部在 popup 内解码；本 SW 仅服务
 * 「popup 关闭后仍要执行」的场景——快捷键直扫（§5.1）与右键识别（§5.2，实验性）。
 *
 * SW 随时休眠：不依赖全局状态跨事件存续（offscreen 创建锁仅在同一轮事件内有效，
 * 存在性每次经 chrome.runtime.getContexts() 现查，116+）。
 */
importScripts('i18n.js');

var MENU_ID = 'qr2link-scan-image';
var BADGE_MS = 3000;
var MESSAGE_TIMEOUT_MS = 15000; // offscreen 消息链超时：须大于 qr.js 的 10s 取图超时，避免误杀

var creating = null; // offscreen 创建 Promise 锁（防连击重复创建）
var seq = 0;         // 消息自增 id（防串线）

// ---- offscreen 单例（handoff §4.5：每次现查，不缓存句柄） ----
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (ctx.length > 0) return;
  if (creating) return creating; // 并发调用共享同一次创建
  const pending = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: 'Decode QR images locally in a hidden document; the service worker has no DOM/canvas.',
  });
  creating = pending;
  try {
    await pending;
  } finally {
    // 失败也必须释放锁：否则 creating 永远是 rejected promise，后续直扫/右键全部持续失败（验收 review #1）
    if (creating === pending) creating = null;
  }
}

// ---- 消息超时包装（迟到的回复随原 promise 悬空，无副作用） ----
function withTimeout(promise, ms) {
  var timer = null;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('OFFSCREEN_TIMEOUT')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
}

// ---- badge 反馈（无链接 / 无结果 / 失败） ----
var badgeTimer = null; // 清除定时器去重：否则连续失败时前一次的定时器会清掉后一次刚设置的 ✕（验收 review #9）

function flashFail() {
  if (badgeTimer) clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: self.I18N.badgeFail });
  // SW 中 setTimeout 3 秒通常可行；若被休眠打断则下次设置时覆盖，可接受（handoff §4.5）
  badgeTimer = setTimeout(function () {
    badgeTimer = null;
    chrome.action.setBadgeText({ text: '' });
  }, BADGE_MS);
}

// ---- offscreen 解码请求 ----
async function decodeInOffscreen(source) {
  await ensureOffscreen();
  var id = 'dq-' + Date.now() + '-' + (++seq);
  // 消息链本身也要有界：offscreen 异常 / 解码卡死时用户仍能得到 badge ✕ 反馈（验收 review #2）
  var resp = await withTimeout(chrome.runtime.sendMessage({
    type: 'QR2LINK_DECODE',
    id: id,
    source: source,
  }), MESSAGE_TIMEOUT_MS);
  if (!resp || resp.type !== 'QR2LINK_DECODE_RESULT' || resp.id !== id) {
    throw new Error('BAD_OFFSCREEN_REPLY');
  }
  if (!resp.ok) throw new Error(resp.error || 'DECODE_FAILED');
  return resp.results || [];
}

// ---- 打开第一个 http/https 链接（工程默认值：不连环开页，DESIGN §10） ----
// 防合并注释（V1.2-PLAN PR-2 拍板③）：openFirstLink 及其上游 handleScan 刻意【不接入】
// Safety.assessUrl 安全预检——快捷键直扫 / 右键识别维持 v1.1「照常打开」行为契约；
// 安全预检（含 danger 两段式确认）仅在弹窗结果卡片路径生效（popup.js / safety.js）。
// 请勿在此引入 Safety 拦截：e2e G6 锁定了「快捷键路径 danger URL 仍自动打开」+
// 「SW 中不存在 Safety 全局」两条边界。README 使用提示对该边界的明示由 V1.2-PLAN
// PR-4 收尾统一补写（当前 README 尚未包含该句，勿以注释代替实际文档状态）。
async function openFirstLink(results) {
  for (var i = 0; i < results.length; i++) {
    if (results[i].isUrl) {
      await chrome.tabs.create({ url: results[i].text, active: true });
      return true;
    }
  }
  return false;
}

async function handleScan(source) {
  try {
    var results = await decodeInOffscreen(source);
    var opened = await openFirstLink(results);
    if (!opened) flashFail(); // 非 URL 文本 / 无结果：badge ✕，不打扰
  } catch (e) {
    flashFail(); // 截图失败 / 获取失败 / 通信失败
  }
}

// ---- 快捷键直扫（Alt+Shift+S，DESIGN §5.1） ----
chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'scan-current-page') return;
  // 快捷键手势已授予 activeTab → 可截当前可视区域
  chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(function (dataUrl) {
    handleScan({ kind: 'dataURL', value: dataUrl });
  }, function () {
    flashFail(); // 受限页面不可截
  });
});

// ---- 右键图片识别（DESIGN §5.2，跨域图片属实验性） ----
function createMenu() {
  // 先清后建，避免重复 id 报错；标题按当前命中语言包解析（i18n 双语）
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: self.I18N.menuScanImage,
      contexts: ['image'],
    });
  });
}

// onInstalled 覆盖安装/更新；onStartup 覆盖「用户改浏览器语言后重启」——
// 此时 onInstalled 不触发，菜单标题须按新语言重建（I18N-PLAN §4.5）
chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  // fetch 在 offscreen 文档内执行（见 offscreen.js）：同源可取，跨域 CDN 预期失败
  handleScan({ kind: 'url', value: info.srcUrl });
});
