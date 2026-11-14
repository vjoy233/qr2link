/**
 * camera/camera.js — 摄像头扫码页（V1.2-PLAN PR-4，B1）
 *
 * 独立标签页宿主（popup「摄像头扫码」入口 chrome.tabs.create 打开）。getUserMedia
 * 是运行时权限 → manifest 权限零新增。渲染一律 textContent（与 popup 同契约），
 * 「打开」仅限 parseHttpUrl 判定的 http/https 链接。
 *
 * 帧管线（外部 review P1 采纳的帧接缝）：
 *   requestVideoFrameCallback → 离屏 canvas drawImage → getImageData →
 *   QR2Link.decodeFrame（qr.js 单趟引擎链 native→zxing→jsQR 空结果接力，
 *   无三阶段/像素预算/墙钟——摄像头帧 ≤1080p 小图，静态图策略不适用）
 * 并发控制：in-flight 丢帧锁（上一帧解码未完成直接丢帧）+ 150ms 节流（附加限频，
 * 非排队——被限的帧直接跳过，永不积压）。
 *
 * 生命周期：
 *   - 命中 → 停循环出横幅（结果 + 打开/复制/「继续扫」）；流保持运行（预览不死），
 *     「继续扫」重建循环（流已被停则重新 getUserMedia）
 *   - pagehide / visibilitychange(hidden) → 停循环 + 停全部 track（帧数据仅内存
 *     处理、页面退出即弃，不落盘不上传）；因隐藏/导航而停的（且当时在扫描）在回前台
 *     / BFCache pageshow(persisted) 时自动恢复（PR #7 AIbot review P2 采纳）
 *   - 取流竞态防护（review P1 采纳）：startSeq 取流代号——重试/切设备/恢复重叠时，
 *     过期的 getUserMedia/enumerateDevices 结果自弃并对旧流 tracks 立即止损
 *     （防 MediaStream 泄漏：摄像头常亮/设备占用）
 *   - 运行中流中断（设备拔出/系统撤销权限）→ track ended 停循环 + 可重试引导（review P1）
 *   - 分辨率控制（review P1/P2 采纳）：getUserMedia ideal 约束 + submitFrame 对超
 *     FRAME_MAX_SIDE 的帧硬性等比降采样——高分辨率摄像头（4K）下单帧解码成本有界
 *   - 设备选择器：enumerateDevices 报告多摄像头时显示，切换即重启流（无 label 兜底走 i18n）
 *   - 权限拒绝 / 无设备 → 引导文案（拒绝可重试）
 *   - 「识别后自动打开」开关默认关、仅会话内有效，不持久化（PR-4 拍板）
 *
 * 测试钩子（沿 getLastDecodeStats 探针先例）：window.Camera.__testInjectFrame(imageData)
 * 与生产共用 decodeFrame 并走同一 onHit 路径（e2e fake 流是绿球视频无码，解码断言
 * 靠注入帧）；__testStats() 返回帧计数与循环/流状态探针。
 */
(function () {
  'use strict';

  var T = self.I18N;
  var Q = window.QR2Link;

  // 附加限频：in-flight 丢帧锁之上再限最低帧间隔。rVFC 与视频轨同步（常见 ~30fps），
  // 全码制单趟解码最坏百 ms 级——150ms ≈ 6.7fps 对准静态码绰绰有余，且给引擎留余量
  var FRAME_MIN_INTERVAL_MS = 150;
  // 单帧解码边长上限（PR #7 AIbot review P1/P2 采纳）：getUserMedia 约束只给 ideal
  // （不保证），高分辨率摄像头（4K）全帧喂 zxing 单趟可达秒级（无码噪声实测 ~230ms/MP）
  // ——submitFrame 对超限帧等比降采样，单帧解码成本钉死在 ~1MP 当量（约束 + 硬兜底双保险）
  var FRAME_MAX_SIDE = 1280;

  var state = {
    stream: null,         // MediaStream（命中后保留；隐藏/切设备/重取时停止）
    scanning: false,      // 帧循环运行中
    inFlight: false,      // 丢帧锁：上一帧 decodeFrame 未完成
    lastFrameAt: 0,       // 节流：上一帧提交时刻（rVFC now 时基）
    rvfcId: 0,            // requestVideoFrameCallback 句柄
    loopSeq: 0,           // 循环代号：停循环/重建时递增，使在途 decodeFrame 回调自弃
    startSeq: 0,          // 取流代号：start() 递增；getUserMedia/play/enumerateDevices 的
                          // 异步回调携带快照，过期即自弃并止损旧流（PR #7 AIbot review P1 采纳，
                          // logoSeq/loopSeq 同族——重复 start 泄漏旧 MediaStream 的竞态）
    deviceId: '',         // 指定摄像头（空 = 浏览器默认，facingMode 优先后置）
    autoOpen: false,      // 自动打开开关（会话内，不持久化）
    stoppedByHide: false, // 因页面隐藏而停（当时在扫描 → 回前台自动恢复）
    stoppedByNav: false,  // 因导航离开（pagehide）而停（当时在扫描 → BFCache 返回恢复）
  };

  // 测试/诊断计数（framesSeen = rVFC 到帧；Submitted = 通过锁与节流；Decoded = 引擎完成）
  var stats = { framesSeen: 0, framesSubmitted: 0, framesDecoded: 0, hits: 0 };

  var video, canvas, ctx, statusEl, guideEl, guideText, retryBtn,
      bannerEl, bannerText, openBtn, copyBtn, resumeBtn, deviceSel, autoChk;

  // ---------------- i18n（HTML 不留硬编码文案；lang 跟随实际命中语言包） ----------------

  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (typeof T[key] === 'string') nodes[i].textContent = T[key];
    }
    document.title = T.appName + ' · ' + T.cameraTitle;
    document.documentElement.lang = T.localeLang || 'en';
    deviceSel.title = T.cameraDevice;
  }

  // ---------------- 视图状态 ----------------

  function setStatus(text) { statusEl.textContent = text || ''; }

  function setGuide(msg, retryable) {
    if (msg == null) { guideEl.hidden = true; return; }
    guideText.textContent = msg;
    retryBtn.hidden = !retryable;
    guideEl.hidden = false;
  }

  function hideBanner() { bannerEl.hidden = true; }

  function flashBtn(btn, msg) {
    var orig = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('flash');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('flash');
    }, 1200);
  }

  // ---------------- 取流与错误引导 ----------------

  function stopTracksOf(stream) {
    if (!stream) return;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) tracks[i].stop();
  }

  function start() {
    stopAll(); // 幂等清理（切设备重入 / 流已死时的「继续扫」）
    var seq = ++state.startSeq; // 取流代号：在途回调据此自弃（review P1 竞态防护）
    setGuide(null);
    hideBanner();
    setStatus(T.cameraStarting);
    navigator.mediaDevices.getUserMedia({
      audio: false,
      // deviceId 指定时 exact 锁定（选择器语义）；否则 facingMode 优先后置（移动端
      // 扫码惯例；桌面无后置概念，等价于默认设备，非 exact 偏好不会失败）。
      // ideal 分辨率/帧率（review P1/P2 采纳）：高分辨率摄像头（4K）下控制单帧成本；
      // ideal 不保证满足 → submitFrame 另有 FRAME_MAX_SIDE 硬性降采样兜底
      video: Object.assign(
        state.deviceId ? { deviceId: { exact: state.deviceId } } : { facingMode: 'environment' },
        { width: { ideal: FRAME_MAX_SIDE }, height: { ideal: FRAME_MAX_SIDE * 9 / 16 }, frameRate: { ideal: 30 } },
      ),
    }).then(function (stream) {
      if (seq !== state.startSeq) {
        // 过期请求（期间发生过重试/切设备/前台恢复）：立即止损，绝不写入 state/srcObject
        // ——否则旧流 tracks 失去引用无法回收（摄像头常亮、设备占用，review P1）
        stopTracksOf(stream);
        return;
      }
      state.stream = stream;
      attachTrackWatchers(stream, seq);
      video.srcObject = stream;
      // muted + playsinline 下 autoplay 恒允许；catch 仅防御（play 拒绝不代表流不可用）
      return video.play().catch(function () { /* 已防御 */ });
    }).then(function () {
      if (seq !== state.startSeq) return;
      renderDevices(seq); // 权限授予后 labels 才可用（枚举结果同样受代号保护）
      startLoop();
    }, function (err) {
      if (seq !== state.startSeq) return; // 过期请求的错误：不打扰新一轮取流
      onMediaError(err);
    });
  }

  // 运行中流中断（设备拔出/系统撤销权限，review P1 采纳）：ended 不经 stopAll 的调用方
  // 触发——监听之，当前流仍有效时停循环清理并给出可重试引导（devicechange 不单独监听：
  // ended 已覆盖本流，设备列表在下次 start 的 renderDevices 刷新）
  function attachTrackWatchers(stream, seq) {
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      tracks[i].addEventListener('ended', function () {
        if (seq !== state.startSeq || state.stream !== stream) return;
        stopAll();
        setStatus('');
        setGuide(T.cameraStreamLost, true); // 设备可能已重新接入：提供重试
      });
    }
  }

  function onMediaError(err) {
    var name = (err && err.name) || '';
    setStatus('');
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      setGuide(T.cameraPermissionDenied, true);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      setGuide(T.cameraNoDevice, false);
    } else {
      setGuide(T.cameraStartFailed, true); // NotReadableable（设备占用）等：重试可能恢复
    }
  }

  // ---------------- 设备选择器 ----------------

  function renderDevices(seq) {
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      if (seq !== state.startSeq) return; // 过期枚举结果：不覆盖新一轮取流的选择器状态（review P2）
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      deviceSel.textContent = '';
      if (cams.length <= 1) { deviceSel.hidden = true; return; } // 单摄像头无需选择器
      // 选中项 = 当前流实际使用的设备（getSettings），而非列表第一项
      var currentId = state.deviceId;
      try {
        var track = state.stream && state.stream.getVideoTracks()[0];
        var s = track && track.getSettings();
        if (s && s.deviceId) currentId = s.deviceId;
      } catch (e) { /* getSettings 不可用则退回 state.deviceId */ }
      for (var i = 0; i < cams.length; i++) {
        var o = document.createElement('option');
        o.value = cams[i].deviceId;
        // 无 label 兜底走 i18n（review P2 采纳：不得硬编码英文）
        o.textContent = cams[i].label || (T.cameraUnknownDevice + ' ' + (i + 1));
        o.selected = cams[i].deviceId === currentId;
        deviceSel.appendChild(o);
      }
      deviceSel.hidden = false;
    }).catch(function () { deviceSel.hidden = true; });
  }

  // ---------------- 帧循环（rVFC + 丢帧锁 + 节流） ----------------

  function startLoop() {
    if (state.scanning) return;
    state.loopSeq++; // 旧循环在途帧全部失效
    state.scanning = true;
    state.inFlight = false;
    state.lastFrameAt = 0;
    hideBanner();
    setStatus(T.cameraScanning);
    scheduleFrame();
  }

  function scheduleFrame() {
    try {
      state.rvfcId = video.requestVideoFrameCallback(onFrame);
    } catch (e) {
      // rVFC 理论必可用（Chrome 83+，manifest 要求 116+）：停循环防死等
      stopLoop();
      setGuide(T.cameraStartFailed, true);
    }
  }

  function onFrame(now) {
    if (!state.scanning) return; // stopLoop 后到达的迟到帧
    scheduleFrame(); // 先续订下一帧：本帧被锁/节流丢弃也不中断循环
    stats.framesSeen++;
    if (state.inFlight) return; // 丢帧锁：上一帧解码未完成，本帧直接丢（不排队）
    if (state.lastFrameAt && now - state.lastFrameAt < FRAME_MIN_INTERVAL_MS) return; // 附加限频
    submitFrame(now);
  }

  function submitFrame(now) {
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return; // 视频轨尺寸未就绪：不入锁，下一帧再试
    state.lastFrameAt = now;
    state.inFlight = true;
    stats.framesSubmitted++;
    var seq = state.loopSeq; // 在途回调归属快照
    try {
      // 高分辨率帧降采样（review P1/P2 采纳）：约束 ideal 不保证满足，这里硬性钉死单帧
      // 解码边长 ≤ FRAME_MAX_SIDE（等比缩放，仅缩小不放大）
      var scale = Math.min(1, FRAME_MAX_SIDE / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(video, 0, 0, w, h, 0, 0, cw, ch);
      var imageData = ctx.getImageData(0, 0, cw, ch);
      Q.decodeFrame(imageData).then(function (results) {
        stats.framesDecoded++;
        if (seq !== state.loopSeq) return; // 旧循环在途帧：不触碰新循环的锁与状态
        state.inFlight = false;
        if (!state.scanning) return; // 已停循环（横幅/隐藏）：静默丢弃
        if (results && results.length > 0) onHit(results[0]);
      }, function () {
        if (seq !== state.loopSeq) return;
        state.inFlight = false; // decodeFrame 全引擎内部 catch，此分支纯防御
      });
    } catch (e) {
      state.inFlight = false; // canvas/getImageData 异常：本帧作废，继续下一帧
    }
  }

  // ---------------- 命中与停止 ----------------

  function onHit(r) {
    if (!state.scanning) return;
    stopLoop(); // 停循环；流保持运行（预览不死，「继续扫」廉价重建）
    stats.hits++;
    setStatus(T.cameraHit);
    bannerText.textContent = r.text; // 存入即原文，打开/复制均从此取
    bannerText.title = r.text;
    openBtn.hidden = !r.isUrl; // 仅 http/https 提供打开（parseHttpUrl 已在 decodeFrame 分类）
    bannerEl.hidden = false;
    if (state.autoOpen && r.isUrl) openUrl(r.text);
  }

  function stopLoop() {
    state.scanning = false;
    state.loopSeq++; // 在途 decodeFrame 回调据此自弃
    try { video.cancelVideoFrameCallback(state.rvfcId); } catch (e) { /* 已触发/未注册 */ }
  }

  function stopAll() {
    stopLoop();
    if (state.stream) {
      var tracks = state.stream.getTracks();
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      state.stream = null;
    }
    video.srcObject = null;
  }

  function openUrl(raw) {
    var url = Q.parseHttpUrl(raw); // 仅 http/https 白名单（与 popup openUrl 同契约）
    if (!url) return;
    chrome.tabs.create({ url: url, active: true });
  }

  // ---------------- 启动与绑定 ----------------

  function boot() {
    video = document.getElementById('camera-video');
    statusEl = document.getElementById('camera-status');
    guideEl = document.getElementById('camera-guide');
    guideText = document.getElementById('camera-guide-text');
    retryBtn = document.getElementById('camera-retry');
    bannerEl = document.getElementById('camera-banner');
    bannerText = document.getElementById('camera-banner-text');
    openBtn = document.getElementById('camera-open');
    copyBtn = document.getElementById('camera-copy');
    resumeBtn = document.getElementById('camera-resume');
    deviceSel = document.getElementById('camera-device');
    autoChk = document.getElementById('camera-auto-open');

    // 离屏 canvas：仅作 video → ImageData 的转换介质，不入 DOM
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    applyI18n();

    retryBtn.addEventListener('click', start);
    deviceSel.addEventListener('change', function () {
      state.deviceId = deviceSel.value;
      start(); // 切设备：停旧流、按 exact deviceId 重启
    });
    openBtn.addEventListener('click', function () { openUrl(bannerText.textContent); });
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(bannerText.textContent).then(function () {
        flashBtn(copyBtn, T.copied);
      }, function () {
        flashBtn(copyBtn, T.copyFailed); // 写入被拒也要有反馈（同 popup copyText 哲学）
      });
    });
    resumeBtn.addEventListener('click', function () {
      // 流仍在（命中只停循环）→ 直接重建；流已死（隐藏停流/轨结束）→ 重新取流
      var track = state.stream && state.stream.getVideoTracks()[0];
      if (track && track.readyState === 'live') startLoop();
      else start();
    });
    autoChk.addEventListener('change', function () {
      state.autoOpen = autoChk.checked; // 仅会话内有效，不持久化（PR-4 拍板）
    });

    // 页面退出/切后台：停循环 + 停全部 track（帧数据随之弃置，仅内存生命周期）
    // BFCache（review P2 采纳）：前进/后退导航离开触发 pagehide，返回时文档不重载而走
    // pageshow(persisted)——记录「因导航而停」，恢复时重新取流（与 visibilitychange 同族）
    window.addEventListener('pagehide', function () {
      state.stoppedByNav = state.scanning; // 横幅/引导态不自动恢复（用户显式继续）
      stopAll();
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted && state.stoppedByNav) {
        state.stoppedByNav = false;
        start(); // BFCache 返回：流已在 pagehide 停止，重新取流恢复扫描
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        state.stoppedByHide = state.scanning; // 横幅/引导态不自动恢复（用户显式继续）
        stopAll();
      } else if (state.stoppedByHide) {
        state.stoppedByHide = false;
        start(); // 回前台自动恢复扫描（重新取流）
      }
    });

    // 页面即扫码目的：popup 入口点击（= 用户手势）打开，加载即取流
    start();
  }

  boot();

  // ---------------- 测试钩子（__ 前缀：不属产品 API，e2e 专用） ----------------

  window.Camera = {
    // 注入一帧（ImageData）：与生产共用 decodeFrame，命中走同一 onHit（横幅/停循环）；
    // 不占用 in-flight 锁（生产锁语义由 onFrame 路径自测）
    __testInjectFrame: function (imageData) {
      return Q.decodeFrame(imageData).then(function (results) {
        if (results && results.length > 0) onHit(results[0]);
        return results;
      });
    },
    // 帧计数与状态探针：断言「循环持续出帧 / 停止 / 恢复」用，不驱动产品逻辑
    __testStats: function () {
      var track = state.stream && state.stream.getVideoTracks()[0];
      return {
        framesSeen: stats.framesSeen,
        framesSubmitted: stats.framesSubmitted,
        framesDecoded: stats.framesDecoded,
        hits: stats.hits,
        scanning: state.scanning,
        inFlight: state.inFlight,
        loopSeq: state.loopSeq,
        streamLive: !!(track && track.readyState === 'live'),
      };
    },
  };
})();
