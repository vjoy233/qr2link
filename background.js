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

var creating = null; // offscreen 创建 Promise 锁（防连击重复创建）
var seq = 0;         // 消息自增 id（防串线）

// ---- offscreen 单例（handoff §4.5：每次现查，不缓存句柄） ----
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (ctx.length > 0) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: 'Service Worker 无 DOM/canvas，需要隐藏文档本地解码二维码图片',
  });
  await creating;
  creating = null;
}

// ---- badge 反馈（无链接 / 无结果 / 失败） ----
function flashFail() {
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: self.I18N.badgeFail });
  // SW 中 setTimeout 3 秒通常可行；若被休眠打断则下次设置时覆盖，可接受（handoff §4.5）
  setTimeout(function () { chrome.action.setBadgeText({ text: '' }); }, BADGE_MS);
}

// ---- offscreen 解码请求 ----
async function decodeInOffscreen(source) {
  await ensureOffscreen();
  var id = 'dq-' + Date.now() + '-' + (++seq);
  var resp = await chrome.runtime.sendMessage({
    type: 'QR2LINK_DECODE',
    id: id,
    source: source,
  });
  if (!resp || resp.type !== 'QR2LINK_DECODE_RESULT' || resp.id !== id) {
    throw new Error('BAD_OFFSCREEN_REPLY');
  }
  if (!resp.ok) throw new Error(resp.error || 'DECODE_FAILED');
  return resp.results || [];
}

// ---- 打开第一个 http/https 链接（工程默认值：不连环开页，DESIGN §10） ----
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
chrome.runtime.onInstalled.addListener(function () {
  // 安装/更新都会触发：先清后建，避免重复 id 报错
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: self.I18N.menuScanImage,
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  // fetch 在 offscreen 文档内执行（见 offscreen.js）：同源可取，跨域 CDN 预期失败
  handleScan({ kind: 'url', value: info.srcUrl });
});
