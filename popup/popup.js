/**
 * popup.js — QR2Link 弹窗主逻辑（DESIGN §4）
 *
 * 状态机：idle(home) → preview(框选，仅截图入口) → decoding(status) → results | error(status)
 *   上传 / 粘贴 / 剪贴板按钮走快路径：直接 decoding；失败后才提供「框选重试」进 preview。
 * 安全约束（DESIGN §4.4）：
 *   - 结果渲染一律 textContent，二维码内容绝不拼入 innerHTML；
 *   - 打开仅限 parseHttpUrl 判定为 http/https 的结果；
 *   - 全 popup 唯一剪贴板写入点 = 「复制」按钮的 navigator.clipboard.writeText。
 */
(function () {
  'use strict';

  var T = self.I18N;
  var Q = window.QR2Link;

  var HISTORY_KEY_ENABLED = 'qr2link.history.enabled'; // DESIGN §5.3 key 约定
  var HISTORY_KEY_ITEMS = 'qr2link.history.items';
  var HISTORY_MAX = 20;

  var state = {
    view: 'home',
    busy: false,        // 解码进行中，屏蔽重复触发
    imageBlob: null,    // 可供「框选重试」的源图片（失败路径保留，成功路径释放）
    thumb: null,        // 结果缩略图 dataURL（成功后生成小图，随即释放源 Blob）
    lastResults: null,
    history: { enabled: false, items: [] },
    clearArmed: null,   // 清空历史两步确认的定时器
  };

  function $(id) { return document.getElementById(id); }

  // ---------------- i18n 绑定（HTML 不留硬编码中文） ----------------
  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (typeof T[key] === 'string') nodes[i].textContent = T[key];
    }
    document.title = T.appName;
  }

  // ---------------- 视图切换（动态宽度：DESIGN §4.0） ----------------
  var VIEWS = ['home', 'preview', 'status', 'results'];

  function setView(name) {
    state.view = name;
    for (var i = 0; i < VIEWS.length; i++) {
      $(('view-' + VIEWS[i])).hidden = VIEWS[i] !== name;
    }
    if (name === 'home') {
      document.body.dataset.mode = 'compact';
      resetWorkImage();
    } else if (name === 'preview' || name === 'results') {
      document.body.dataset.mode = 'wide';
    }
    // status（识别中/错误）保持进入前的宽度模式
  }

  function resetWorkImage() {
    state.imageBlob = null;
    state.thumb = null;
  }

  // ---------------- 状态视图 ----------------
  function showDecoding() {
    setView('status');
    $('status-spinner').hidden = false;
    $('status-title').textContent = T.decoding;
    $('status-hint').textContent = '';
    $('btn-retry-crop').hidden = true;
  }

  function showError(title, hint, retryable) {
    setView('status');
    $('status-spinner').hidden = true;
    $('status-title').textContent = title;
    $('status-hint').textContent = hint || '';
    $('btn-retry-crop').hidden = !(retryable && state.imageBlob);
  }

  // ---------------- 解码主流程 ----------------
  function runDecode(blob, rect) {
    if (state.busy) return;
    state.busy = true;
    state.imageBlob = blob; // 失败路径供「框选重试」；成功路径在渲染后释放
    showDecoding();

    Q.decodeImage(blob, rect ? { rect: rect } : undefined).then(function (results) {
      state.busy = false;
      if (!results || results.length === 0) {
        showError(T.errNoQrTitle, T.errNoQrHint, true);
        return;
      }
      makeThumb(blob).then(function (thumb) {
        state.thumb = thumb;
        state.imageBlob = null; // 成功路径释放源 Blob（DESIGN §6.6）
        state.lastResults = results;
        renderResults(results);
        setView('results');
      });
    }, function (err) {
      state.busy = false;
      var key = err && err.message === 'IMAGE_FETCH_FAILED' ? 'errFetchImage' : 'errImageDecode';
      showError(T[key], '', true);
    });
  }

  // 小缩略图（≤64px）：仅保留 dataURL，避免持有大图引用
  function makeThumb(blob) {
    return new Promise(function (resolve) {
      var done = function (v) { resolve(v); };
      if (typeof createImageBitmap !== 'function') { done(null); return; }
      createImageBitmap(blob).then(function (bmp) {
        try {
          var s = Math.min(1, 64 / Math.max(bmp.width, bmp.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(bmp.width * s));
          c.height = Math.max(1, Math.round(bmp.height * s));
          var ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0, c.width, c.height);
          var url = c.toDataURL('image/png');
          c.width = 0;
          c.height = 0;
          bmp.close();
          done(url);
        } catch (e) {
          try { bmp.close(); } catch (e2) { /* 已关闭 */ }
          done(null);
        }
      }, function () { done(null); });
    });
  }

  // ---------------- 预览 / 框选 ----------------
  function enterPreviewAndCrop(blob) {
    state.imageBlob = blob;
    setView('preview');
    window.Crop.openCrop(blob).then(function (decision) {
      if (!decision || decision.action === 'cancel') {
        setView('home');
        return;
      }
      if (decision.action === 'error') {
        showError(T.errImageDecode, '', false);
        return;
      }
      if (decision.action === 'crop') {
        runDecode(blob, decision.rect);
      } else { // full
        runDecode(blob, undefined);
      }
    });
  }

  // ---------------- 结果渲染（一律 textContent） ----------------
  function resultActions(r) {
    var box = document.createElement('div');
    box.className = 'result-actions';
    if (r.isUrl) {
      var open = document.createElement('button');
      open.className = 'mini-btn';
      open.textContent = T.btnOpen;
      open.addEventListener('click', function () { openUrl(r.text); });
      box.appendChild(open);
    }
    var copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.textContent = T.btnCopy;
    copy.addEventListener('click', function () { copyText(r.text, copy); });
    box.appendChild(copy);
    if (state.history.enabled) {
      var keep = document.createElement('button');
      keep.className = 'mini-btn';
      keep.textContent = T.btnKeep;
      keep.addEventListener('click', function () { keepResult(r, keep); });
      box.appendChild(keep);
    }
    return box;
  }

  function renderResults(results) {
    var list = $('result-list');
    list.textContent = '';
    for (var i = 0; i < results.length; i++) {
      (function (r) {
        var card = document.createElement('div');
        card.className = 'result-card';
        if (state.thumb) {
          var im = document.createElement('img');
          im.className = 'result-thumb';
          im.alt = '';
          im.src = state.thumb;
          card.appendChild(im);
        }
        var body = document.createElement('div');
        body.className = 'result-body';
        var meta = document.createElement('div');
        meta.className = 'result-meta';
        meta.textContent = r.isUrl ? 'URL' : (T.textLabel + ' · ' + r.engine);
        var text = document.createElement('div');
        text.className = 'result-text';
        text.textContent = r.text; // trim 后原始文本（qr.js 已处理）
        text.title = r.text;       // 悬浮显示全文
        body.appendChild(meta);
        body.appendChild(text);
        card.appendChild(body);
        card.appendChild(resultActions(r));
        list.appendChild(card);
      })(results[i]);
    }
  }

  function openUrl(raw) {
    var url = Q.parseHttpUrl(raw); // 仅 http/https 白名单（DESIGN §4.4）
    if (!url) return;
    chrome.tabs.create({ url: url, active: true }); // 用户点击触发，新前台标签页
  }

  // 唯一剪贴板写入点：仅「复制」按钮调用
  function copyText(text, btn) {
    return navigator.clipboard.writeText(text).then(function () {
      flashBtn(btn, T.copied);
    }, function () { /* 聚焦异常静默 */ });
  }

  function flashBtn(btn, msg) {
    if (!btn) return;
    var orig = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('flash');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('flash');
    }, 1200);
  }

  // ---------------- 历史（chrome.storage.local，默认关闭） ----------------
  function loadHistory() {
    return chrome.storage.local.get([HISTORY_KEY_ENABLED, HISTORY_KEY_ITEMS]).then(function (o) {
      state.history.enabled = o[HISTORY_KEY_ENABLED] === true;
      state.history.items = Array.isArray(o[HISTORY_KEY_ITEMS]) ? o[HISTORY_KEY_ITEMS] : [];
    });
  }

  function saveHistory() {
    return chrome.storage.local.set({
      'qr2link.history.enabled': state.history.enabled,
      'qr2link.history.items': state.history.items,
    });
  }

  function keepResult(r, btn) {
    state.history.items.unshift({ text: r.text, isUrl: !!r.isUrl, ts: Date.now() });
    state.history.items = state.history.items.slice(0, HISTORY_MAX); // ≤20 条
    saveHistory().then(renderHistory);
    flashBtn(btn, T.kept);
  }

  function historyRow(item, idx) {
    var row = document.createElement('div');
    row.className = 'history-item';
    var text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = item.text;
    text.title = item.text;
    row.appendChild(text);
    if (item.isUrl) {
      row.appendChild(miniAction(T.btnOpen, function () { openUrl(item.text); }));
    }
    row.appendChild(miniAction(T.btnCopy, function (ev) { copyText(item.text, ev.target); }));
    row.appendChild(miniAction(T.historyDelete, function () {
      state.history.items.splice(idx, 1);
      saveHistory().then(renderHistory);
    }));
    return row;
  }

  function miniAction(label, fn) {
    var b = document.createElement('button');
    b.className = 'mini-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function muted(msg) {
    var d = document.createElement('div');
    d.className = 'history-empty';
    d.textContent = msg;
    return d;
  }

  function renderHistory() {
    var toggle = $('history-toggle');
    var list = $('history-list');
    var clearBtn = $('history-clear');
    toggle.checked = state.history.enabled;
    list.textContent = '';
    if (!state.history.enabled) {
      list.appendChild(muted(T.historyOff));
      clearBtn.hidden = true;
      disarmClear();
      return;
    }
    if (state.history.items.length === 0) {
      list.appendChild(muted(T.historyEmpty));
      clearBtn.hidden = true;
      disarmClear();
      return;
    }
    clearBtn.hidden = false;
    for (var i = 0; i < state.history.items.length; i++) {
      list.appendChild(historyRow(state.history.items[i], i));
    }
  }

  function disarmClear() {
    if (state.clearArmed) {
      clearTimeout(state.clearArmed);
      state.clearArmed = null;
    }
    $('history-clear').textContent = T.historyClear;
  }

  // 两步确认（扩展弹窗中 confirm() 会导致失焦关闭，改用按钮翻转）
  function onClearClick() {
    var btn = $('history-clear');
    if (state.clearArmed) {
      state.history.items = [];
      saveHistory().then(renderHistory);
      return;
    }
    btn.textContent = T.historyClearConfirm;
    state.clearArmed = setTimeout(disarmClear, 3000);
  }

  // ---------------- 三入口 ----------------
  function onScreenshot() {
    if (state.busy) return;
    chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(function (dataUrl) {
      // dataURL → Blob（fetch 对 data: URL 不发网络请求）
      return fetch(dataUrl).then(function (resp) { return resp.blob(); });
    }).then(function (blob) {
      enterPreviewAndCrop(blob); // 截图入口：先进预览框选（DESIGN §4.1）
    }, function () {
      showError(T.errCaptureTitle, T.errCaptureHint, false); // 特殊页面等，引导粘贴/上传
    });
  }

  function handleFile(file) {
    if (state.busy || !file) return;
    if (!/^image\//.test(file.type)) return; // 只收图片
    runDecode(file, undefined); // 快路径：立即解码
  }

  function onReadClipboard() {
    if (state.busy) return;
    navigator.clipboard.read().then(function (items) {
      var found = null;
      for (var i = 0; i < items.length && !found; i++) {
        var types = items[i].types || [];
        for (var j = 0; j < types.length; j++) {
          if (types[j].indexOf('image/') === 0) { found = items[i].getType(types[j]); break; }
        }
      }
      if (!found) {
        showError(T.errClipboardNoImage, '', false);
        return;
      }
      found.then(function (blob) { runDecode(blob, undefined); },
        function () { showError(T.errClipboardRead, T.errClipboardReadHint, false); });
    }, function () {
      showError(T.errClipboardRead, T.errClipboardReadHint, false);
    });
  }

  function onPaste(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) {
          e.preventDefault();
          if (!state.busy) runDecode(f, undefined);
          return;
        }
      }
    }
    // 双通道一致：粘贴内容中无图片 → 同样提示
    if (!state.busy) showError(T.errClipboardNoImage, '', false);
  }

  // ---------------- 拖拽 ----------------
  var dragDepth = 0;

  function setupDrag() {
    var overlay = $('drop-overlay');
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f); // 非图片静默忽略
    });
  }

  // ---------------- 绑定与启动 ----------------
  function boot() {
    applyI18n();

    $('btn-screenshot').addEventListener('click', onScreenshot);
    $('btn-upload').addEventListener('click', function () { $('file-input').click(); });
    $('btn-clipboard').addEventListener('click', onReadClipboard);
    $('file-input').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = ''; // 允许重复选择同一文件
      handleFile(f);
    });

    $('btn-back-preview').addEventListener('click', function () { window.Crop.cancel(); });
    $('btn-back-results').addEventListener('click', function () { setView('home'); });
    $('btn-retry-crop').addEventListener('click', function () {
      if (state.imageBlob) enterPreviewAndCrop(state.imageBlob);
    });

    $('history-toggle').addEventListener('change', function () {
      state.history.enabled = this.checked;
      saveHistory().then(function () {
        renderHistory();
        if (state.view === 'results' && state.lastResults) renderResults(state.lastResults); // 保留按钮可见性联动
      });
    });
    $('history-clear').addEventListener('click', onClearClick);

    document.addEventListener('paste', onPaste, false);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.view === 'preview') window.Crop.cancel();
      else if (state.view === 'results' || state.view === 'status') setView('home');
    });

    setupDrag();
    loadHistory().then(renderHistory);
    setView('home');
  }

  boot();
})();
