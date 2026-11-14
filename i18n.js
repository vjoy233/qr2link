/**
 * i18n.js — UI 文案装载（chrome.i18n 中英双语版，DESIGN §6.7 演进 / I18N-PLAN）
 *
 * 对外接口 self.I18N.<camelKey> 与旧版常量表完全一致，popup.js / crop.js /
 * background.js 调用方零改动。语言由 Chrome 按浏览器 UI 语言自动匹配
 * （zh-CN → zh_CN；en-* → en；其余回落 default_locale=en）。
 *
 * key 三处同源：_locales/{en,zh_CN}/messages.json 与本文件 KEYS，
 * 由 scripts/check-locales.mjs 静态校验强一致（run-all 前置 + 发版清单）。
 * 注意：self 在 window 与 Service Worker 中均可用；chrome.i18n 亦然。
 */
(function () {
  'use strict';

  var KEYS = [
    // 头部
    'appName', 'appSubtitle',
    // 主页三入口
    'btnScreenshot', 'btnScreenshotSub', 'btnUpload', 'btnUploadSub',
    'btnClipboard', 'inputHint', 'dropHere',
    // 预览 / 框选
    'cropHint', 'btnScanFull', 'btnScanCrop', 'btnBack',
    // 状态
    'decoding', 'errNoQrTitle', 'errNoQrHint', 'errCaptureTitle', 'errCaptureHint',
    'errClipboardNoImage', 'errClipboardRead', 'errClipboardReadHint',
    'errImageDecode', 'errFetchImage', 'btnRetryCrop',
    // 结果卡片
    'btnOpen', 'btnCopy', 'btnKeep', 'copied', 'copyFailed', 'kept', 'textLabel',
    // 结构化解析卡片（V1.2-PLAN PR-2，C1）
    'parseKindWifi', 'parseKindOtp', 'parseKindVcard', 'parseKindTel', 'parseKindSms',
    'parseKindMail', 'parseKindGeo',
    'parseWifiSsid', 'parseWifiAuth', 'parseWifiPass', 'parseWifiHidden', 'parseWifiAuthNone',
    'parseYes', 'parseNo',
    'parseOtpCode', 'parseOtpIssuer', 'parseOtpAccount', 'parseOtpSecret', 'parseOtpAlgorithm',
    'parseOtpDigits', 'parseOtpPeriod', 'parseOtpCounter', 'parseOtpHotpHint',
    'parseShowSecret', 'parseHideSecret',
    'parseVcardName', 'parseVcardTel', 'parseVcardEmail', 'parseVcardOrg', 'parseVcardTitle',
    'btnDownloadVcf',
    'parseTelNumber', 'parseSmsBody', 'parseMailTo', 'parseMailSubject', 'parseMailBody',
    'parseGeoLat', 'parseGeoLon',
    // 生成视图（V1.2-PLAN PR-3，D1+D2；点阵/定位角选项用 canonical 名不进 i18n）
    'btnGenerate', 'btnGenerateSub',
    'generatePlaceholder', 'generateTooLong',
    'generateDotsStyle', 'generateCornerStyle', 'generateFgColor', 'generateBgColor',
    'generateLogo', 'generateLogoRemove', 'generateLogoNotImage', 'generateLogoTooLarge',
    'btnDownloadPng', 'btnCopyImage', 'generateDownloadFailed',
    // 摄像头扫码（V1.2-PLAN PR-4，B1；独立标签页 camera/camera.html）
    'btnCamera', 'btnCameraSub',
    'cameraTitle', 'cameraDevice', 'cameraStarting', 'cameraScanning', 'cameraHit',
    'cameraAutoOpen', 'cameraPermissionDenied', 'cameraNoDevice', 'cameraStartFailed',
    'cameraRetry', 'cameraResume',
    // 安全预检指示条（V1.2-PLAN PR-2，C2）
    'safetyLevelOk', 'safetyLevelCaution', 'safetyLevelDanger',
    'safetyReasonIdn', 'safetyReasonUserPass', 'safetyReasonHttp', 'safetyReasonIp',
    'safetyReasonShort', 'safetyConfirmOpen', 'safetyShowReasons', 'safetyHideReasons',
    // 历史
    'historyTitle', 'historyOff', 'historyEmpty', 'historyClear',
    'historyClearConfirm', 'historyDelete',
    // background（右键菜单 / badge）
    'menuScanImage', 'badgeFail',
    // 内部：实际命中语言包的 <html lang> 值（见 popup.js applyI18n）
    'localeLang',
  ];

  // camelCase → messages.json 的 snake_case key（平台命名惯例）
  function snake(k) { return k.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); }

  self.I18N = KEYS.reduce(function (T, k) {
    // getMessage 对缺失 key 返回 ""：兜底显示 key 名本身，漏翻译在 UI 上一眼可见
    //（check-locales 使其不可能进入发版包，此兜底仅用于开发期自暴露）
    T[k] = chrome.i18n.getMessage(snake(k)) || k;
    return T;
  }, {});
})();
