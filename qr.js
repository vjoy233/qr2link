/**
 * qr.js — QR2Link 共享解码模块（popup / offscreen 共用，经典脚本，无构建步骤）
 *
 * 挂载全局命名空间 window.QR2Link：
 *   canUseNativeQr()                      运行时检测原生 BarcodeDetector 是否支持 qr_code
 *   parseHttpUrl(raw)                     仅接受 http/https 链接，其余返回 null（DESIGN §4.4）
 *   decodeImage(source, opts)             三阶段解码，引擎按阶段分档（V1.2-PLAN PR-1，见下）
 *   decodeFrame(imageData)                摄像头帧单趟解码（V1.2-PLAN PR-4，见下方说明）
 *   getLastDecodeStats()                  最近一次 decodeImage 的阶段执行记录（测试/诊断探针，见下方说明）
 *
 * 引擎分档（zxing-wasm 引入后，V1.2-PLAN「zxing 性能基准」实测定档；PR #4 review 采纳：
 * native 命中后不再短路 zxing——native 仅 QR，短路会漏同图 1D/DataMatrix 码，改为合并去重）：
 *   阶段 1（≤2000px 快扫）：native + zxing 合并（native 空也不影响 zxing）；仍无命中时 jsQR 兜底
 *   阶段 2（全分辨率）：rect ≤ 20MP 走 native + zxing 合并（jsQR 仅 zxingBroken 时参与）；
 *                      20–50MP 维持 native → 空时 jsQR（v1.1 行为零变化，40MP 大图小码 B 用例锁定）
 *   阶段 3（象限梯子）：native → jsQR 原样（issue #1 的 jsQR 多码救回机制；zxing 多码在 1/2 已覆盖）
 *   zxing 覆盖全码制（QR + 1D + DataMatrix/Aztec/PDF417），jsQR/native 仍仅 QR；
 *   已知边界：>20MP 图上的混合码（QR+1D）在 native 命中 QR 时 1D 可能漏（该档刻意不走 zxing 控耗时）
 *
 * source: Blob | dataURL 字符串 | http(s) URL 字符串
 *   注意：URL 字符串的 fetch 在「调用方所在文档」执行——右键识别链路必须由 offscreen 调用。
 * opts.rect: {x, y, w, h} 原图坐标裁剪区域（popup 框选），缺省为全图。
 *
 * 返回 Promise<[{text, isUrl, engine, format}]>（文本已去重、trim；format 为 zxing canonical
 * 码制名如 'QRCode'/'EAN13'/'Code128'，native/jsQR 命中恒为 'QRCode'）；
 * 图片解码 / 获取失败时 reject(Error)；解码成功但无二维码时 resolve([])。
 */
(function () {
  'use strict';

  var STAGE1_MAX_SIDE = 2000; // 阶段 1 降采样目标：最长边上限（DESIGN §3.3）
  var FETCH_TIMEOUT_MS = 10000; // 远程取图超时：黑洞网络下 fetch 永不返回，用户将无限等待（DESIGN §5.2）
  // 阶段 2 全分辨率像素预算（50MP ≈ 8000×6000）：超出则跳过全图重扫，避免 canvas/getImageData
  // 内存暴涨与失败风险；用户可框选缩小范围后仍走全分辨率（DESIGN §3.3，验收 review #3）。
  // 50MP 下限保证 8000×5000（40MP）大图小码场景不受影响
  var STAGE2_MAX_PIXELS = 50000000;
  // 阶段 2 的 zxing 像素分档（V1.2-PLAN「zxing 性能基准」实测定档，2026-11-13 参考机）：
  // zxing 无码噪声图实测 20MP≈3.7s / 30MP≈6.0s / 50MP≈11.7s（tryHarder/tryRotate/tryInvert/
  // tryDownscale 默认全开），线性外推 ~230ms/MP；取 20MP 保证阶段 2 单程 ≤5s 验收线。
  // 超过本档的全分辨率重试仍由 jsQR 承担（≤50MP，行为与 v1.1 完全一致——40MP 大图小码
  // 场景 jsQR 命中早退实测 1.2s，B 用例锁定）。无码最坏链路耗时整体不劣于 v1.1
  var STAGE2_ZXING_MAX_PIXELS = 20000000;
  // 阶段 3 象限分块分辨率档位：rect ≤ 9MP（4K 截图 ≈ 8.3MP）逐块全分辨率扫；
  // 更大图（≤50MP，超出不进入阶段 3）按阶段 1 档位（最长边 ≤2000px）分块——定位点跨码
  // 误配与分辨率无关，逐块降采样仍可救较大的码；耗时上界由 RESCAN_BUDGET_MS 墙钟预算
  // 兜底（单机实测仅作参考：9MP 全梯子 ≈ 4s），不给 offscreen 消息链 15s 超时添险（issue #1）
  var STAGE3_MAX_RECT_PIXELS = 9000000;
  // 重扫墙钟预算：自阶段 2 起算，覆盖「全分辨率重试 + 阶段 3 全梯子」的累计耗时。
  // 像素预算（50MP/9MP 档位）只能约束扫描量，无法跨设备换算成耗时上界（外部 review #2：
  // 单机实测 9MP ≈ 4s 不构成证明）；慢设备上由本预算截停梯子尾部（4×4 等投机趟次），
  // 落回「未识别到 + 框选重试」。取 8s 的拆账：offscreen 消息链 15s 超时（background.js）
  // − 取图余量（右键 URL 源最多 ~5s）− 解码/阶段 1/通信（~1s）− 截停超弛（截停检查在
  // tile 开工前，最后一个已开工 tile 须跑完，最坏 ~1-2s）。popup 路径无消息超时，
  // 但 spinner 同样受益（不再无限转）。
  // 注意阶段 2 本身是单趟不可中断（其上界即 50MP 像素预算），本预算用于阻止阶段 3 在其上叠加
  var RESCAN_BUDGET_MS = 8000;
  // 阶段 3 分块几何梯子：单轴切分（1×2 / 2×1）救「近满幅并排/堆叠双码」——这类码会被
  // 2×2 的中线拦腰切断（实测 two-codes.png 2×2 全 miss）；2×2 救四角均布，4×4 救更密均布。
  // 每趟网格全跑、命中合并（后趟可救前趟被切坏或与邻码共存的码），由 decodeImage 统一去重；
  // 超出墙钟预算时逐 tile 截停（趟次按已验证价值排序，单轴与 2×2 在前）
  var STAGE3_GRIDS = [[1, 2], [2, 1], [2, 2], [4, 4]];

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

  // ---- zxing-wasm 引擎（V1.2-PLAN PR-1；vendor IIFE 全局 ZXingWASM，随包 wasm）----
  // 关键：发行版默认 locateFile 指向 jsDelivr CDN——违反零网络承诺 + CWS 远程代码政策，
  // 必须重写为 chrome.runtime.getURL 指向 lib/zxing_reader.wasm（随扩展打包）。
  // 初始化失败（CSP 回归 / 浏览器 bug / wasm 损坏）→ zxingBroken 永久置位，
  // 引擎链静默降级 jsQR——与上方「原生异常静默降级」同构（外部 review：jsQR 保留应急，拍板④）
  var zxingInitPromise = null;
  var zxingBroken = false;

  function initZxing() {
    if (zxingBroken) return Promise.resolve(false);
    if (!zxingInitPromise) {
      zxingInitPromise = (async function () {
        try {
          if (typeof ZXingWASM === 'undefined' || typeof ZXingWASM.prepareZXingModule !== 'function') {
            throw new Error('NO_ZXING_GLOBAL');
          }
          await ZXingWASM.prepareZXingModule({
            overrides: {
              locateFile: function (path) {
                return path && path.indexOf('.wasm') !== -1
                  ? chrome.runtime.getURL('lib/zxing_reader.wasm')
                  : path;
              },
            },
            fireImmediately: true, // await 真正完成 wasm 实例化，而非仅登记 overrides
          });
          return true;
        } catch (e) {
          zxingBroken = true; // 永久降级；不做重试（每次 decode 重试坏模块只会放大卡顿）
          return false;
        }
      })();
    }
    return zxingInitPromise;
  }

  // 单趟 zxing 读取（全码制；textMode Plain 保证 1D 原文不被 HRI 改写）。
  // maxNumberOfSymbols 8：覆盖四角均布等现实多码，同时给无码噪声图上的投机扫描封顶。
  // 单趟运行期异常视为「本引擎不可用」：置 zxingBroken 后按无结果返回，后续趟次走 jsQR
  async function zxingRead(imageData) {
    try {
      var results = await ZXingWASM.readBarcodes(imageData, { textMode: 'Plain', maxNumberOfSymbols: 8 });
      var hits = [];
      for (var i = 0; i < (results || []).length; i++) {
        var r = results[i];
        if (r && r.text) hits.push({ text: r.text, engine: 'zxing', format: r.format || null });
      }
      return hits;
    } catch (e) {
      zxingBroken = true;
      return [];
    }
  }

  // ---- 阶段执行记录（测试/诊断探针）----
  // 最近一次 decodeImage 的阶段选择与阶段 3 执行细节。阈值行为（50MP 预算 / 9MP 档位）
  // 无法从解码结果稳定反推，E2E 边界用例（TEST-RESULTS §9）据此严格锁定（外部 review #2）。
  // 同一文档内并发解码会互相覆盖，仅约定为串行诊断读取，产品逻辑不依赖此对象
  var lastDecodeStats = null;

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

  // ---- 在指定分辨率下跑一遍引擎序列（引擎按阶段分档，V1.2-PLAN PR-1）----
  // engines: { zxing: Boolean 该档是否启用 zxing, jsqr: Boolean 无命中时是否兜 jsQR }
  //   阶段 1：{zxing:true, jsqr:true}——三引擎全跑，兜「zxing 健康但漏识别」回归面（外部 review 修订版）
  //   阶段 2 ≤20MP：{zxing:true, jsqr:false}——jsQR 仅在 zxingBroken 时兜（大图双引擎会超墙钟）
  //   阶段 2 >20MP / 阶段 3：{zxing:false, jsqr:true}——与 v1.1 行为一致
  // 返回原始命中数组 [{text, engine, format?}]
  async function decodePass(loaded, rect, maxSide, engines) {
    engines = engines || { zxing: true, jsqr: true };
    var sw = rect.w, sh = rect.h;
    var scale = Math.min(1, maxSide / Math.max(sw, sh)); // 仅缩不小放大
    var cw = Math.max(1, Math.round(sw * scale));
    var ch = Math.max(1, Math.round(sh * scale));
    // 浏览器 canvas 单边上限（Chromium 32767）：极端长宽比图（如 40000×500）按本趟无结果处理，
    // 外层统一走「未识别到 + 框选重试」，而非抛异常（验收 review #3）
    if (cw > 32767 || ch > 32767) return [];

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
          if (codes[i] && codes[i].rawValue) hits.push({ text: codes[i].rawValue, engine: 'native', format: 'QRCode' });
        }
      } catch (e) { /* 静默降级 */ }
    }

    // ② zxing（全码制，多码原生）：与 native 命中合并、不短路——native 仅 QR，短路会漏同图
    // 1D/DataMatrix 码（PR #4 review P1：混合码图随浏览器不同丢结果）；重复文本由 decodeImage
    // 统一去重（先 native 后 zxing，同文以 native 标签保留）。wasm 懒加载（首次 decode 才实例化）
    if (engines.zxing && !zxingBroken && await initZxing()) {
      var zxHits = await zxingRead(imageData);
      for (var z = 0; z < zxHits.length; z++) hits.push(zxHits[z]);
    }

    // ③ jsQR 兜底（仅 QR）：无命中且（本档允许 或 zxing 损坏）时执行（保证识别一个，DESIGN §2.1）
    if (hits.length === 0 && typeof jsQR === 'function' && (engines.jsqr || zxingBroken)) {
      try {
        var code = jsQR(imageData.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) hits.push({ text: code.data, engine: 'jsqr', format: 'QRCode' });
      } catch (e) { /* jsQR 内部异常按无结果处理 */ }
    }

    // 释放本趟 canvas
    canvas.width = 0;
    canvas.height = 0;
    return hits;
  }

  // ---- 阶段 3：象限分块重扫（issue #1 多码图）----
  // 背景：jsQR 单码引擎对多码图定位点跨码误配，表现为「整体 miss」而非少识别一个
  // （TEST-RESULTS §5.2 / issue #1）；分块后单块内通常至多一码即可命中。
  // 将 rect 按网格均分为 cols×rows 块（相邻块共享边界，坐标取整对齐）
  function gridTiles(rect, cols, rows) {
    var tiles = [];
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var x0 = rect.x + Math.round(i * rect.w / cols);
        var x1 = rect.x + Math.round((i + 1) * rect.w / cols);
        var y0 = rect.y + Math.round(j * rect.h / rows);
        var y1 = rect.y + Math.round((j + 1) * rect.h / rows);
        tiles.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
    return tiles;
  }

  // 全梯子扫完合并（不按趟早停：后趟网格能救前趟被切坏或与邻码同块共存的码）；
  // 极端布局（如 3 列均布网格、密集骑缝码）仍可能 miss → 落回「未识别到 + 框选重试」。
  // deadline 为重扫墙钟预算的截止时刻（performance.now 时基）：超时在下一个 tile 前截停，
  // 已扫部分照常合并返回——截停的是排在前面的已验证趟次之后的投机趟次，属可接受降级
  async function decodeTiled(loaded, rect, deadline) {
    var perTileMaxSide = rect.w * rect.h <= STAGE3_MAX_RECT_PIXELS ? Infinity : STAGE1_MAX_SIDE;
    var hits = [];
    lastDecodeStats.stages.push('3');
    lastDecodeStats.stage3FullResTiles = perTileMaxSide === Infinity;
    for (var g = 0; g < STAGE3_GRIDS.length; g++) {
      var tiles = gridTiles(rect, STAGE3_GRIDS[g][0], STAGE3_GRIDS[g][1]);
      var ranInGrid = false;
      for (var i = 0; i < tiles.length; i++) {
        if (performance.now() > deadline) {
          lastDecodeStats.stage3DeadlineCut = true;
          return hits; // 超预算：剩余 tile/趟次不再执行（外部 review #2，P1）
        }
        var tileHits = await decodePass(loaded, tiles[i], perTileMaxSide, { zxing: false, jsqr: true });
        ranInGrid = true;
        lastDecodeStats.stage3TilesRun++;
        for (var k = 0; k < tileHits.length; k++) hits.push(tileHits[k]);
      }
      if (ranInGrid) lastDecodeStats.stage3GridsRun++;
    }
    return hits;
  }

  // ---- 三阶段主流程（DESIGN §3.3）----
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

      // 阶段 1：最长边 > 2000px 时等比降采样快扫（三引擎全跑兜回归面，外部 review 修订版）
      lastDecodeStats = {
        stages: ['1'], stage3FullResTiles: null, stage3GridsRun: 0, stage3TilesRun: 0, stage3DeadlineCut: false,
        zxingBroken: zxingBroken, stage2Engine: null,
      };
      var hits = await decodePass(loaded, rect, STAGE1_MAX_SIDE, { zxing: true, jsqr: true });

      // 重扫墙钟预算自此刻起算：阶段 2 自身单趟不可中断（上界即像素预算分档），
      // 预算用于阻止阶段 3 在其上继续叠加（外部 review #2，P1）
      var rescanDeadline = performance.now() + RESCAN_BUDGET_MS;

      // 阶段 2：无任何结果 → 原图全分辨率重试（覆盖大图小码）
      // 像素预算内才执行：超出 50MP 的全图重扫得不偿失，落到「未识别到 + 框选重试」（验收 review #3）。
      // 引擎分档（V1.2-PLAN 性能基准）：≤20MP 走 zxing（实测单程 ≤3.7s）；20–50MP 维持 jsQR
      // （v1.1 行为零变化——40MP 大图小码命中早退 1.2s，B 用例锁定）
      if (hits.length === 0 && rect.w * rect.h <= STAGE2_MAX_PIXELS) {
        var useZxingStage2 = rect.w * rect.h <= STAGE2_ZXING_MAX_PIXELS;
        hits = await decodePass(loaded, rect, Infinity, { zxing: useZxingStage2, jsqr: !useZxingStage2 });
        // stage2Engine 记录实际引擎：zxingBroken（含本趟内刚置位）时实际由 jsQR 兜底（PR #4 review P2-3）
        lastDecodeStats.stage2Engine = (useZxingStage2 && !zxingBroken) ? 'zxing' : 'jsqr';
        lastDecodeStats.stages.push('2');

        // 阶段 3：仍无结果 → 象限分块重扫（issue #1 多码图）：1×2/2×1/2×2/4×4 逐块跑引擎序列，
        // 救「多码分布均匀」场景（jsQR 整体 miss）；仅阶段 2 实际执行过才进入——
        // 超 50MP 大图维持「框选重试」契约不变（验收 review #3 行为锁定，B33）。
        // 已知边界：jsQR 在全图上已解出 ≥1 码时不分块（无法廉价区分「仅此一码」与
        // 「多码漏网其一」），该情形下漏掉的码仍走「框选重试」（issue 范围即整体 miss）。
        // 注意逐块降采样（≤2000px）远比整图降采样温和（如 5000→2000 仅 2.5×），
        // 故超 9MP 大图分块仍可能救出阶段 1 扫不出的较大码
        if (hits.length === 0) {
          hits = await decodeTiled(loaded, rect, rescanDeadline);
        }
      }

      // 探针终值回写：zxingBroken 在本次解码中才置位时，初始快照会是 false，此处校正
      lastDecodeStats.zxingBroken = zxingBroken;

      return finalizeHits(hits);
    } finally {
      releaseImage(loaded); // 无论成败都释放 bitmap / 引用（DESIGN §6.6）
    }
  }

  // 命中数组 → 对外结果（去重 + trim + 链接分类 + 码制归一），decodeImage / decodeFrame 共用。
  // native/jsQR 命中恒 'QRCode'；zxing 为 canonical 名（decodePass 已保证非空 text 才入列）
  function finalizeHits(hits) {
    var seen = Object.create(null);
    var results = [];
    for (var i = 0; i < hits.length; i++) {
      var t = (hits[i].text || '').trim();
      if (!t || seen[t]) continue;
      seen[t] = true;
      results.push({ text: t, isUrl: !!parseHttpUrl(t), engine: hits[i].engine, format: hits[i].format || 'QRCode' });
    }
    return results;
  }

  // ---- 摄像头帧单趟解码（V1.2-PLAN PR-4，B1；帧接缝为外部 review P1 采纳）----
  // camera.js 的连续帧循环与 decodeImage 的静态图三阶段策略（降采样/像素预算/墙钟/象限
  // 梯子）互不适用——摄像头帧 ≤1080p 小图，这里只跑单趟引擎链：
  //   native → zxing 合并（与 decodePass 阶段 1 同构：native 仅 QR，不短路 zxing 防
  //   混合码图丢 1D）→ 仍无命中时 jsQR 兜底（空结果接力）
  // 差异于 decodePass：直接消费 ImageData（camera 侧已 drawImage + getImageData，无二次
  // canvas 与缩放）；不写 lastDecodeStats（帧循环高频调用会冲掉静态图解码的诊断快照——
  // 该探针是 decodeImage 的测试/诊断契约，产品逻辑不依赖，见上方说明）。
  // 返回结构与 decodeImage 完全同构；帧数据仅内存处理（camera 契约：不落盘不上传）
  async function decodeFrame(imageData) {
    if (!imageData || !imageData.width || !imageData.height) return [];
    var hits = [];

    // ① 原生引擎：detect 直接收 ImageData（ImageBitmapSource 子类型），无需中间 canvas
    if (await getNativeCheck()) {
      try {
        var detector = await getNativeDetector();
        var codes = await detector.detect(imageData);
        for (var i = 0; i < codes.length; i++) {
          if (codes[i] && codes[i].rawValue) hits.push({ text: codes[i].rawValue, engine: 'native', format: 'QRCode' });
        }
      } catch (e) { /* 静默降级 */ }
    }

    // ② zxing（全码制，多码原生）：wasm 懒加载，首次帧才实例化
    if (!zxingBroken && await initZxing()) {
      var zxHits = await zxingRead(imageData);
      for (var z = 0; z < zxHits.length; z++) hits.push(zxHits[z]);
    }

    // ③ jsQR 兜底（仅 QR）：无命中时执行（zxingBroken 时必然走到这里，应急路径）
    if (hits.length === 0 && typeof jsQR === 'function') {
      try {
        var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) hits.push({ text: code.data, engine: 'jsqr', format: 'QRCode' });
      } catch (e) { /* jsQR 内部异常按无结果处理 */ }
    }

    return finalizeHits(hits);
  }

  window.QR2Link = {
    canUseNativeQr: canUseNativeQr,
    parseHttpUrl: parseHttpUrl,
    decodeImage: decodeImage,
    decodeFrame: decodeFrame,
    getLastDecodeStats: function () { return lastDecodeStats; },
  };
})();
