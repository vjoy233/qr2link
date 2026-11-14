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
    capturing: false,   // 截图捕获进行中（双击防重；不可复用 busy——失败须释放，否则入口锁死）
    reading: false,     // 剪贴板读取进行中（同上）
    imageBlob: null,    // 可供「框选重试」的源图片（失败路径保留，成功路径释放）
    thumb: null,        // 结果缩略图 dataURL（成功后生成小图，随即释放源 Blob）
    lastResults: null,
    history: { enabled: false, items: [] },
    clearArmed: null,   // 清空历史两步确认的定时器
    totpTimers: [],     // TOTP 卡片的 setInterval 句柄（重渲染 / 离开结果视图时清理）
  };

  function $(id) { return document.getElementById(id); }

  // ---------------- i18n 绑定（HTML 不留硬编码文案） ----------------
  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (typeof T[key] === 'string') nodes[i].textContent = T[key];
    }
    document.title = T.appName;
    // lang 跟随「实际命中的语言包」（locale_lang 为各语言包自描述值）：
    // 比 getUILanguage() 更准——如 zh-TW UI 无 zh_TW 包时命中 default(en)，lang 应为 en
    document.documentElement.lang = T.localeLang || 'en';
  }

  // ---------------- 视图切换（动态宽度：DESIGN §4.0） ----------------
  var VIEWS = ['home', 'preview', 'status', 'results', 'generate'];

  function setView(name) {
    state.view = name;
    for (var i = 0; i < VIEWS.length; i++) {
      $(('view-' + VIEWS[i])).hidden = VIEWS[i] !== name;
    }
    if (name !== 'results') clearTotpTimers(); // TOTP 倒计时随视图切换清理（V1.2-PLAN PR-2）
    if (name === 'home') {
      document.body.dataset.mode = 'compact';
      resetWorkImage();
    } else if (name === 'preview' || name === 'results') {
      document.body.dataset.mode = 'wide';
    } else if (name === 'generate') {
      document.body.dataset.mode = 'wide';
      window.Generate.open(); // 幂等：首次构建 + 恢复草稿/预填（V1.2-PLAN PR-3）
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
      // 直接引用字面量 key（T.errFetchImage / T.errImageDecode），落入 check-locales 引用闭包静态校验
      showError(err && err.message === 'IMAGE_FETCH_FAILED' ? T.errFetchImage : T.errImageDecode, '', true);
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

  // ---------------- 结果渲染（一律 textContent；V1.2-PLAN PR-2：结构化卡片 + 安全预检） ----------------

  // kind → 卡片标题（直接引用保持 check-locales 静态闭包可校验，不走 computed access）
  var KIND_TITLES = {
    wifi: T.parseKindWifi, totp: T.parseKindOtp, hotp: T.parseKindOtp,
    vcard: T.parseKindVcard, tel: T.parseKindTel, sms: T.parseKindSms,
    mailto: T.parseKindMail, geo: T.parseKindGeo,
  };

  function parsedRow(label, valueEl) {
    var row = document.createElement('div');
    row.className = 'parsed-row';
    var l = document.createElement('span');
    l.className = 'parsed-label';
    l.textContent = label;
    row.appendChild(l);
    if (valueEl) row.appendChild(valueEl);
    return row;
  }

  function parsedVal(text) {
    var s = document.createElement('span');
    s.className = 'parsed-value';
    s.textContent = text;
    return s;
  }

  // 密钥默认打码、点击切换（与结果原文/历史行同款哲学：显示层打码，复制取原文）
  var SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; // 与 parsers.js maskSecrets 同款 •×8
  function secretValueWithToggle(secret) {
    var wrap = document.createElement('span');
    wrap.className = 'parsed-secret';
    var val = document.createElement('span');
    val.className = 'parsed-value secret-value';
    val.textContent = SECRET_MASK;
    var btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = T.parseShowSecret;
    var shown = false;
    btn.addEventListener('click', function () {
      shown = !shown;
      val.textContent = shown ? secret : SECRET_MASK;
      btn.textContent = shown ? T.parseHideSecret : T.parseShowSecret;
    });
    wrap.appendChild(val);
    wrap.appendChild(btn);
    return wrap;
  }

  function clearTotpTimers() {
    for (var i = 0; i < state.totpTimers.length; i++) clearInterval(state.totpTimers[i]);
    state.totpTimers = [];
  }

  // TOTP 动态码：每秒刷新（重算 HMAC 代价微小，天然跨周期换码）+ 剩余秒倒计时
  function scheduleTotp(card, parsed) {
    var codeEl = card.querySelector('.otp-code');
    var cdEl = card.querySelector('.otp-countdown');
    if (!codeEl || !cdEl) return;
    var tick = function () {
      var now = Date.now();
      Parsers.generateTotp(parsed.secret, parsed, now).then(function (code) {
        if (codeEl.isConnected) codeEl.textContent = code; // 卡片已被重渲染时静默丢弃
      }, function () { /* Bad secret 不应发生（parse 已校验） */ });
      cdEl.textContent = Parsers.totpRemaining(parsed.period, now) + 's';
    };
    tick();
    state.totpTimers.push(setInterval(tick, 1000));
  }

  function renderParsedCard(r) {
    var p = Parsers.parse(r.text);
    if (!p) return null; // 解析失败/不支持 → 调用方回落纯文本卡片（锁定契约）
    var card = document.createElement('div');
    card.className = 'parsed-card';
    card.dataset.kind = p.kind;
    var title = document.createElement('div');
    title.className = 'parsed-title';
    title.textContent = KIND_TITLES[p.kind] || T.textLabel;
    card.appendChild(title);

    if (p.kind === 'wifi') {
      card.appendChild(parsedRow(T.parseWifiSsid, parsedVal(p.ssid)));
      card.appendChild(parsedRow(T.parseWifiAuth, parsedVal(p.auth === 'nopass' ? T.parseWifiAuthNone : p.auth)));
      if (p.password != null) {
        var passRow = parsedRow(T.parseWifiPass, parsedVal(p.password));
        var copyPass = document.createElement('button');
        copyPass.className = 'mini-btn';
        copyPass.textContent = T.btnCopy;
        copyPass.addEventListener('click', function () { copyText(p.password, copyPass); });
        passRow.appendChild(copyPass);
        card.appendChild(passRow);
      }
      card.appendChild(parsedRow(T.parseWifiHidden, parsedVal(p.hidden ? T.parseYes : T.parseNo)));
    } else if (p.kind === 'totp' || p.kind === 'hotp') {
      if (p.kind === 'totp') {
        // 大号动态码 + 倒计时 + 复制（拍板①：WebCrypto 本地生成）
        var otpRow = document.createElement('div');
        otpRow.className = 'otp-row';
        var codeEl = document.createElement('span');
        codeEl.className = 'otp-code';
        codeEl.textContent = '······'.slice(0, p.digits);
        var cdEl = document.createElement('span');
        cdEl.className = 'otp-countdown';
        var copyCode = document.createElement('button');
        copyCode.className = 'mini-btn';
        copyCode.textContent = T.btnCopy;
        copyCode.addEventListener('click', function () {
          // 重算当前时刻的码再复制（与展示同源，避免占位符/跨秒时刻差）
          Parsers.generateTotp(p.secret, p, Date.now()).then(function (code) { copyText(code, copyCode); });
        });
        otpRow.appendChild(codeEl);
        otpRow.appendChild(cdEl);
        otpRow.appendChild(copyCode);
        card.appendChild(otpRow);
      } else {
        var hint = document.createElement('div');
        hint.className = 'parsed-hint';
        hint.textContent = T.parseOtpHotpHint;
        card.appendChild(hint);
      }
      if (p.issuer) card.appendChild(parsedRow(T.parseOtpIssuer, parsedVal(p.issuer)));
      if (p.account) card.appendChild(parsedRow(T.parseOtpAccount, parsedVal(p.account)));
      card.appendChild(parsedRow(T.parseOtpSecret, secretValueWithToggle(p.secret)));
      card.appendChild(parsedRow(T.parseOtpAlgorithm, parsedVal(p.algorithm)));
      card.appendChild(parsedRow(T.parseOtpDigits, parsedVal(String(p.digits))));
      if (p.kind === 'totp') card.appendChild(parsedRow(T.parseOtpPeriod, parsedVal(String(p.period) + 's')));
      else card.appendChild(parsedRow(T.parseOtpCounter, parsedVal(String(p.counter))));
    } else if (p.kind === 'vcard') {
      if (p.fn) card.appendChild(parsedRow(T.parseVcardName, parsedVal(p.fn)));
      for (var t = 0; t < p.tels.length; t++) card.appendChild(parsedRow(T.parseVcardTel, parsedVal(p.tels[t])));
      for (var e = 0; e < p.emails.length; e++) card.appendChild(parsedRow(T.parseVcardEmail, parsedVal(p.emails[e])));
      if (p.org) card.appendChild(parsedRow(T.parseVcardOrg, parsedVal(p.org)));
      if (p.title) card.appendChild(parsedRow(T.parseVcardTitle, parsedVal(p.title)));
      // 下载 .vcf：data-URI anchor（原文即二维码解码文本；不经过任何 HTML 解析）
      var dl = document.createElement('a');
      dl.className = 'mini-btn';
      dl.textContent = T.btnDownloadVcf;
      dl.setAttribute('download', 'contact.vcf');
      dl.setAttribute('href', 'data:text/vcard;charset=utf-8,' + encodeURIComponent(p.raw));
      var dlRow = document.createElement('div');
      dlRow.className = 'parsed-actions';
      dlRow.appendChild(dl);
      card.appendChild(dlRow);
    } else if (p.kind === 'tel') {
      card.appendChild(parsedRow(T.parseTelNumber, parsedVal(p.number)));
    } else if (p.kind === 'sms') {
      card.appendChild(parsedRow(T.parseTelNumber, parsedVal(p.number)));
      if (p.body != null) card.appendChild(parsedRow(T.parseSmsBody, parsedVal(p.body)));
    } else if (p.kind === 'mailto') {
      card.appendChild(parsedRow(T.parseMailTo, parsedVal(p.to)));
      if (p.subject != null) card.appendChild(parsedRow(T.parseMailSubject, parsedVal(p.subject)));
      if (p.body != null) card.appendChild(parsedRow(T.parseMailBody, parsedVal(p.body)));
    } else if (p.kind === 'geo') {
      card.appendChild(parsedRow(T.parseGeoLat, parsedVal(String(p.lat))));
      card.appendChild(parsedRow(T.parseGeoLon, parsedVal(String(p.lon))));
    }

    if (p.kind === 'totp') scheduleTotp(card, p);
    return card;
  }

  // ---------------- 安全指示条（C2：纯本地启发式；danger 见两段式打开） ----------------
  // 枚举 key → i18n 文案（直接引用，保持静态闭包可校验）
  var SAFETY_LEVELS = { ok: T.safetyLevelOk, caution: T.safetyLevelCaution, danger: T.safetyLevelDanger };
  var SAFETY_REASONS = {
    idnHomograph: T.safetyReasonIdn,
    userPass: T.safetyReasonUserPass,
    httpPlain: T.safetyReasonHttp,
    ipHost: T.safetyReasonIp,
    shortLink: T.safetyReasonShort,
  };

  function renderSafetyBar(rawUrl) {
    var a = window.Safety.assessUrl(rawUrl);
    var bar = document.createElement('div');
    bar.className = 'safety-bar ' + a.level;
    bar.dataset.level = a.level;
    var dot = document.createElement('span');
    dot.className = 'safety-dot';
    dot.setAttribute('aria-hidden', 'true');
    var level = document.createElement('span');
    level.className = 'safety-level';
    level.textContent = SAFETY_LEVELS[a.level] || '';
    bar.appendChild(dot);
    bar.appendChild(level);
    if (a.reasons.length) {
      var list = document.createElement('ul');
      list.className = 'safety-reasons';
      list.hidden = true;
      for (var i = 0; i < a.reasons.length; i++) {
        var li = document.createElement('li');
        li.textContent = SAFETY_REASONS[a.reasons[i]] || a.reasons[i];
        list.appendChild(li);
      }
      var toggle = document.createElement('button');
      toggle.className = 'link-btn';
      toggle.textContent = T.safetyShowReasons;
      toggle.addEventListener('click', function () {
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden ? T.safetyShowReasons : T.safetyHideReasons;
      });
      bar.appendChild(toggle);
      bar.appendChild(list);
    }
    return bar;
  }

  function resultActions(r) {
    var box = document.createElement('div');
    box.className = 'result-actions';
    if (r.isUrl) {
      var open = document.createElement('button');
      open.className = 'mini-btn';
      open.textContent = T.btnOpen;
      var assess = r.isUrl ? window.Safety.assessUrl(r.text) : null;
      if (assess && assess.level === 'danger') {
        // 拍板⑦：danger 级两段式确认（复用 history-clear 的 3s 解除模式；caution/ok 一键直开）
        var armed = null; // 定时器句柄即 armed 态
        var disarm = function () {
          if (armed) clearTimeout(armed);
          armed = null;
          open.textContent = T.btnOpen;
          open.classList.remove('danger-armed');
        };
        open.addEventListener('click', function () {
          if (armed) {
            disarm();
            openUrl(r.text); // 3 秒内二次点击 = 确认打开
            return;
          }
          open.textContent = T.safetyConfirmOpen;
          open.classList.add('danger-armed');
          armed = setTimeout(disarm, 3000);
        });
      } else {
        open.addEventListener('click', function () { openUrl(r.text); });
      }
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
    clearTotpTimers(); // 重渲染前先清旧倒计时（历史开关联动会重复进入）
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
        var metaText = r.isUrl ? 'URL' : (T.textLabel + ' · ' + r.engine);
        // 全码制（V1.2-PLAN PR-1）：非 QR 码制在 meta 前部展示 canonical 名（如 EAN13/Code128），
        // QR 命中保持原展示不变（format 恒 'QRCode'，不追加）
        if (r.format && r.format !== 'QRCode') metaText = r.format + ' · ' + metaText;
        meta.textContent = metaText;
        var text = document.createElement('div');
        text.className = 'result-text';
        // 显示层打码（V1.2-PLAN PR-2 review P1）：otpauth 的 secret= 显示 ••；复制/保留仍取 r.text 原文
        var display = Parsers.maskSecrets(r.text);
        text.textContent = display;
        text.title = display;
        body.appendChild(meta);
        body.appendChild(text);
        // 结构化卡片（C1）：命中即在原文下追加（渲染全 textContent；失败返回 null 不追加）
        var parsedCard = renderParsedCard(r);
        if (parsedCard) body.appendChild(parsedCard);
        // 安全指示条（C2）：仅 http(s) 卡片；danger 级「打开」走两段式（resultActions）
        if (r.isUrl) body.appendChild(renderSafetyBar(r.text));
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
    }, function () {
      flashBtn(btn, T.copyFailed); // 写入被拒也要有反馈，否则像按钮失效（验收 review #5）
    });
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
    // otpauth 的 secret= 显示层打码（存储/复制保持原文）；「显示」按钮切换明文（review P1）
    var masked = Parsers.maskSecrets(item.text);
    text.textContent = masked;
    text.title = masked;
    row.appendChild(text);
    if (masked !== item.text) {
      var reveal = miniAction(T.parseShowSecret, function () {
        var shown = text.textContent === masked ? item.text : masked;
        text.textContent = shown;
        text.title = shown;
        reveal.textContent = shown === masked ? T.parseShowSecret : T.parseHideSecret;
      });
      row.appendChild(reveal);
    }
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
    if (state.busy || state.capturing) return;
    state.capturing = true;
    var done = function () { state.capturing = false; };
    chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(function (dataUrl) {
      // dataURL → Blob（fetch 对 data: URL 不发网络请求）
      return fetch(dataUrl).then(function (resp) { return resp.blob(); });
    }).then(function (blob) {
      done();
      enterPreviewAndCrop(blob); // 截图入口：先进预览框选（DESIGN §4.1）
    }, function () {
      done();
      showError(T.errCaptureTitle, T.errCaptureHint, false); // 特殊页面等，引导粘贴/上传
    });
  }

  function handleFile(file) {
    if (state.busy || !file) return;
    if (!/^image\//.test(file.type)) return; // 只收图片
    runDecode(file, undefined); // 快路径：立即解码
  }

  function onReadClipboard() {
    if (state.busy || state.reading) return;
    state.reading = true;
    var done = function () { state.reading = false; };
    navigator.clipboard.read().then(function (items) {
      var found = null;
      for (var i = 0; i < items.length && !found; i++) {
        var types = items[i].types || [];
        for (var j = 0; j < types.length; j++) {
          if (types[j].indexOf('image/') === 0) { found = items[i].getType(types[j]); break; }
        }
      }
      if (!found) {
        done();
        showError(T.errClipboardNoImage, '', false);
        return;
      }
      found.then(function (blob) {
        done();
        runDecode(blob, undefined);
      }, function () {
        done();
        showError(T.errClipboardRead, T.errClipboardReadHint, false);
      });
    }, function () {
      done();
      showError(T.errClipboardRead, T.errClipboardReadHint, false);
    });
  }

  function onPaste(e) {
    // 生成视图内的粘贴是文本输入（textarea），不走识别通道——否则纯文本粘贴会被
    // 「剪贴板中没有图片」错误页劫持（V1.2-PLAN PR-3）
    if (state.view === 'generate') return;
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
    $('btn-camera').addEventListener('click', function () {
      // 摄像头扫码：独立标签页宿主（getUserMedia 是运行时权限，manifest 权限零新增）
      chrome.tabs.create({ url: chrome.runtime.getURL('camera/camera.html') });
    });
    $('btn-generate').addEventListener('click', function () { setView('generate'); });
    $('btn-back-generate').addEventListener('click', function () { setView('home'); });
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
      else if (state.view === 'results' || state.view === 'status' || state.view === 'generate') setView('home');
    });

    setupDrag();
    loadHistory().then(renderHistory);
    setView('home');
  }

  boot();
})();
