/**
 * qr.js — QR2Link 共享解码模块（popup / offscreen 共用，经典脚本，无构建步骤）
 *
 * 挂载全局命名空间 window.QR2Link：
 *   canUseNativeQr()                      运行时检测原生 BarcodeDetector 是否支持 qr_code
 *   parseHttpUrl(raw)                     仅接受 http/https 链接，其余返回 null（DESIGN §4.4）
 *   decodeImage(source, opts)             两阶段双引擎解码（DESIGN §3.3）
 *
 * source: Blob | dataURL 字符串 | http(s) URL 字符串
 *   注意：URL 字符串的 fetch 在「调用方所在文档」执行——右键识别链路必须由 offscreen 调用。
 * opts.rect: {x, y, w, h} 原图坐标裁剪区域（popup 框选），缺省为全图。
 *
 * 返回 Promise<[{text, isUrl, engine}]>（文本已去重、trim）；
 * 图片解码 / 获取失败时 reject(Error)；解码成功但无二维码时 resolve([])。
 */
(function () {
  'use strict';

  var STAGE1_MAX_SIDE = 2000; // 阶段 1 降采样目标：最长边上限（DESIGN §3.3）
  var FETCH_TIMEOUT_MS = 10000; // 远程取图超时：黑洞网络下 fetch 永不返回，用户将无限等待（DESIGN §5.2）

  // ---- 原生引擎能力检测（DESIGN §2.1，结果按页面会话缓存）----
  var nativeCheckPromise = null;

  async function canUseNativeQr() {
    if (!('BarcodeDetector' in globalThis)) return false;
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      return formats.includes('qr_code');
    } catch { return false; }
  }

  function getNativeCheck() {
    if (!nativeCheckPromise) nativeCheckPromise = canUseNativeQr();
    return nativeCheckPromise;
  }

  var nativeDetector = null; // 惰性单例

  async function getNativeDetector() {
    if (nativeDetector) return nativeDetector;
    // 构造也全程包裹：任何异常静默降级 jsQR（DESIGN §2.1）
    nativeDetector = await new BarcodeDetector({ formats: ['qr_code'] });
    return nativeDetector;
  }

  // ---- 链接解析（DESIGN §4.4 逐字照抄）----
  function parseHttpUrl(raw) {
    const value = raw.trim();
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
    } catch { return null; }
  }

  // ---- 图片源统一转 Blob ----
  async function sourceToBlob(source) {
    if (source instanceof Blob) return source;
    if (typeof source === 'string' && source) {
      // dataURL 不走网络；http(s) URL（右键链路）带 10s 超时（DESIGN §5.2）：
      // 超时/网络失败统一按「取图失败」降级，popup 沿用 errFetchImage 文案，SW 端 badge ✕
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(source, { signal: ctrl.signal });
        if (!resp.ok) throw new Error('IMAGE_FETCH_FAILED');
        return await resp.blob();
      } catch (e) {
        throw new Error('IMAGE_FETCH_FAILED');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('UNSUPPORTED_SOURCE');
  }

  // ---- 解码为可绘制图像源（ImageBitmap 优先，EXIF 方向修正；失败回退 <img>）----
  async function loadImage(source) {
    const blob = await sourceToBlob(source);
    try {
      try {
        return { img: await createImageBitmap(blob, { imageOrientation: 'from-image' }), bitmap: true };
      } catch (e) {
        // 选项不支持（旧内核）或带选项解码失败：再试一次无选项
        return { img: await createImageBitmap(blob), bitmap: true };
      }
    } catch (e) {
      // createImageBitmap 彻底不可用：回退 <img>（浏览器解码自动应用 EXIF 方向）
      const url = URL.createObjectURL(blob);
      try {
        const el = new Image();
        el.src = url;
        await el.decode();
        return { img: el, bitmap: false };
      } finally {
        URL.revokeObjectURL(url); // decode() 完成后图像数据已在内存，撤销安全
      }
    }
  }

  function releaseImage(loaded) {
    if (!loaded) return;
    if (loaded.bitmap && loaded.img && typeof loaded.img.close === 'function') {
      try { loaded.img.close(); } catch (e) { /* 已关闭 */ }
    }
    loaded.img = null; // canvas / Blob 引用随作用域释放（DESIGN §6.6）
  }

  // ---- 在指定分辨率下跑一遍「原生 → jsQR」引擎序列 ----
  // 返回原始命中数组 [{text, engine}]
  async function decodePass(loaded, rect, maxSide) {
    var sw = rect.w, sh = rect.h;
    var scale = Math.min(1, maxSide / Math.max(sw, sh)); // 仅缩不小放大
    var cw = Math.max(1, Math.round(sw * scale));
    var ch = Math.max(1, Math.round(sh * scale));

    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(loaded.img, rect.x, rect.y, rect.w, rect.h, 0, 0, cw, ch);
    var imageData = ctx.getImageData(0, 0, cw, ch);

    var hits = [];

    // ① 原生引擎（可选加速）：构造与 detect 全程 try/catch，异常静默降级
    if (await getNativeCheck()) {
      try {
        var detector = await getNativeDetector();
        var codes = await detector.detect(canvas);
        for (var i = 0; i < codes.length; i++) {
          if (codes[i] && codes[i].rawValue) hits.push({ text: codes[i].rawValue, engine: 'native' });
        }
      } catch (e) { /* 静默降级 jsQR */ }
    }

    // ② jsQR 兜底：仅当原生无结果时执行（保证识别一个，DESIGN §2.1）
    if (hits.length === 0 && typeof jsQR === 'function') {
      try {
        var code = jsQR(imageData.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) hits.push({ text: code.data, engine: 'jsqr' });
      } catch (e) { /* jsQR 内部异常按无结果处理 */ }
    }

    // 释放本趟 canvas
    canvas.width = 0;
    canvas.height = 0;
    return hits;
  }

  // ---- 两阶段主流程（DESIGN §3.3）----
  async function decodeImage(source, opts) {
    opts = opts || {};
    var loaded = null;
    try {
      loaded = await loadImage(source);
      var W = loaded.img.width || loaded.img.naturalWidth;
      var H = loaded.img.height || loaded.img.naturalHeight;
      if (!W || !H) throw new Error('IMAGE_DECODE_FAILED');

      // 框选矩形（原图坐标）：缺省全图；越界钳制
      var rect = opts.rect
        ? {
            x: Math.max(0, Math.floor(opts.rect.x)),
            y: Math.max(0, Math.floor(opts.rect.y)),
            w: 0, h: 0,
          }
        : { x: 0, y: 0, w: W, h: H };
      rect.w = Math.min(W - rect.x, Math.floor(opts.rect ? opts.rect.w : W));
      rect.h = Math.min(H - rect.y, Math.floor(opts.rect ? opts.rect.h : H));
      if (rect.w <= 0 || rect.h <= 0) throw new Error('INVALID_CROP_RECT');

      // 阶段 1：最长边 > 2000px 时等比降采样快扫
      var hits = await decodePass(loaded, rect, STAGE1_MAX_SIDE);

      // 阶段 2：无任何结果 → 原图全分辨率重试（覆盖大图小码）
      if (hits.length === 0) {
        hits = await decodePass(loaded, rect, Infinity);
      }

      // 去重 + trim + 链接分类
      var seen = Object.create(null);
      var results = [];
      for (var i = 0; i < hits.length; i++) {
        var t = (hits[i].text || '').trim();
        if (!t || seen[t]) continue;
        seen[t] = true;
        results.push({ text: t, isUrl: !!parseHttpUrl(t), engine: hits[i].engine });
      }
      return results;
    } finally {
      releaseImage(loaded); // 无论成败都释放 bitmap / 引用（DESIGN §6.6）
    }
  }

  window.QR2Link = {
    canUseNativeQr: canUseNativeQr,
    parseHttpUrl: parseHttpUrl,
    decodeImage: decodeImage,
  };
})();
