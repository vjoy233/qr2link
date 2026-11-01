/**
 * offscreen.js — Offscreen 文档消息端点（DESIGN §5.1 / §5.2，handoff §4.5）
 *
 * 消息协议（唯一 SW ↔ offscreen 通道）：
 *   SW → offscreen: { type: 'QR2LINK_DECODE', id, source: { kind: 'dataURL' | 'url', value } }
 *   offscreen → SW: { type: 'QR2LINK_DECODE_RESULT', id, ok: true, results: [{text,isUrl,engine}] }
 *                | { type: 'QR2LINK_DECODE_RESULT', id, ok: false, error: string }
 *
 * 约束：本文档内只使用 chrome.runtime 消息通信；右键远程图片的 fetch 在本文档内执行
 * （同源受 activeTab 覆盖，跨域 CDN 预期失败——有意取舍，不加 host 权限）。
 */
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'QR2LINK_DECODE' || !msg.source) return; // 非本协议消息不响应

    (async function () {
      try {
        var value = msg.source.value;
        if (typeof value !== 'string' || !value) throw new Error('BAD_SOURCE');
        // dataURL 与 http(s) URL 均由 qr.js 内部统一 fetch（URL 的 fetch 在本文档执行）
        var results = await window.QR2Link.decodeImage(value);
        sendResponse({ type: 'QR2LINK_DECODE_RESULT', id: msg.id, ok: true, results: results });
      } catch (e) {
        sendResponse({
          type: 'QR2LINK_DECODE_RESULT',
          id: msg.id,
          ok: false,
          error: String((e && e.message) || e),
        });
      }
    })();

    return true; // 异步 sendResponse
  });
})();
