/**
 * i18n.js — UI 文案常量收口（DESIGN §6.7）
 *
 * 仅中文；popup.html 通过 data-i18n 属性绑定，background.js 经 importScripts 使用。
 * 后续接入 chrome.i18n 中英双语时，只需将此处常量翻译为 _locales 映射，不改调用方。
 * 注意：self 在 window 与 Service Worker 中均可用。
 */
(function () {
  'use strict';

  self.I18N = {
    // 头部
    appName: 'QR2Link',
    appSubtitle: '二维码 → 链接',

    // 主页三入口
    btnScreenshot: '截取当前网页',
    btnScreenshotSub: '截取当前标签页可视区域',
    btnUpload: '上传图片',
    btnUploadSub: '选择本地图片文件',
    btnClipboard: '读取剪贴板图片',
    inputHint: '支持 Ctrl+V 粘贴 · 也可拖拽图片到此窗口',
    dropHere: '松开以识别图片',

    // 预览 / 框选
    cropHint: '在预览图中拖拽框选二维码区域（可选，不选则全图识别）',
    btnScanFull: '全图识别',
    btnScanCrop: '识别所选区域',
    btnBack: '返回',

    // 状态
    decoding: '识别中…',
    errNoQrTitle: '未识别到二维码',
    errNoQrHint: '可框选二维码区域后重试，或更换更清晰的图片',
    errCaptureTitle: '截图失败',
    errCaptureHint: '当前页面可能不允许截图。请用系统截图（如 Win+Shift+S）后粘贴，或上传图片',
    errClipboardNoImage: '剪贴板中没有图片',
    errClipboardRead: '剪贴板读取失败',
    errClipboardReadHint: '请先点击弹窗内任意位置再试，或直接按 Ctrl+V',
    errImageDecode: '图片无法读取',
    errFetchImage: '图片获取失败（可能受跨域或网络限制）',
    btnRetryCrop: '框选重试',

    // 结果卡片
    btnOpen: '打开',
    btnCopy: '复制',
    btnKeep: '保留',
    copied: '已复制',
    copyFailed: '复制失败',
    kept: '已保留',
    textLabel: '文本',

    // 历史
    historyTitle: '最近识别',
    historyOff: '历史记录已关闭，开启后可保留识别结果',
    historyEmpty: '暂无保留的记录',
    historyClear: '清空',
    historyClearConfirm: '确认清空？',
    historyDelete: '删除',

    // background（右键菜单 / badge）
    menuScanImage: '识别图中二维码',
    badgeFail: '✕',
  };
})();
