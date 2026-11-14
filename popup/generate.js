/**
 * popup/generate.js — 生成二维码视图组件（V1.2-PLAN PR-3，D1 基础生成 + D2 样式）
 *
 * 弹窗单宿主（拍板⑥）：渲染于 popup.html 固定节点 #generate-root，无独立页面；
 * 全局组件模式（仿 crop.js）。popup.js 进入 generate 视图时调用 Generate.open()。
 *
 * 能力与契约：
 *   - textarea 输入 + 预填当前标签页 URL（popup 打开即有 activeTab，
 *     chrome.tabs.query 可读 url，无需 tabs 权限）；chrome:// 等特殊页 / 无 URL
 *     → 预填为空、仅显占位提示；草稿已存在时草稿优先，不覆盖用户输入
 *   - 草稿持久化：输入内容存 chrome.storage.session（本会话内存级，浏览器关闭即清），
 *     每次 input 即时写盘 —— popup 随时失焦关闭都不丢草稿（拍板⑥配套）
 *   - QRCodeStyling canvas 实时预览；超容量时 qrcode-generator 在 update() 内
 *     同步抛错 → 显示 i18n 超长提示并停用动作（update 已先清空容器，无残留旧码）
 *   - D2 样式：5 种点阵 × 3 种定位角 × 前景/背景色 × logo（本地 file → dataURL）
 *   - 动作：下载 PNG（download()，data-URI anchor）；复制图片（getRawData('png')
 *     → ClipboardItem.write，clipboardWrite 权限已有；失败走 copyFailed 反馈）
 *
 * 命名说明：点阵/定位角选项文案用 canonical ASCII 名（square/dots/…），与结果
 * meta 的码制 format 名同口径（PR-1 先例），不进 i18n。
 *
 * 无定时器 / 无跨视图副作用：离开视图由 popup.js 切换 section 即可，无需清理钩子
 * （对照 popup.js 的 totpTimers 范式 —— 本组件唯一异步是 storage/tabs 读写与
 * 绘制 promise，均为即发即弃，不持有 interval）。
 */
(function () {
  'use strict';

  var T = self.I18N;

  var DRAFT_KEY = 'qr2link.generate.draft'; // 会话级草稿（storage.session）
  var LOGO_MAX_BYTES = 2 * 1024 * 1024;     // logo 上限 2MB（dataURL 进绘制选项，防超大文件拖垮渲染）
  var QR_SIZE = 280;                        // 预览/导出尺寸（正方形）
  var CORNER_DOT_MAP = { square: 'square', dot: 'dot', 'extra-rounded': 'dot' }; // 定位角 → 内点样式

  // 点阵 × 定位角矩阵（与 QRCodeStyling DotType/CornerSquareType 一一对应）
  var DOT_STYLES = ['square', 'rounded', 'dots', 'classy', 'classy-rounded'];
  var CORNER_STYLES = ['square', 'dot', 'extra-rounded'];

  var built = false;     // UI 是否已构建（open 幂等）
  var draftLoaded = false; // 草稿/预填只做一次（重复进出视图不覆盖用户输入）
  var logoData = null;   // logo dataURL（null = 无 logo）
  var lastRenderOk = false; // 当前预览是否有效（空输入/超容量为 false → 动作禁用）

  var root, ta, errEl, qr, dlBtn, copyBtn, logoThumb, logoRemove;

  // ---------------- UI 构建 ----------------

  function optionList(values) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < values.length; i++) {
      var o = document.createElement('option');
      o.value = values[i];
      o.textContent = values[i]; // canonical 名，不进 i18n（文件头注释）
      frag.appendChild(o);
    }
    return frag;
  }

  function build() {
    root = document.getElementById('generate-root');
    root.textContent = '';

    // ---- 左栏：预览 ----
    var layout = document.createElement('div');
    layout.className = 'gen-layout';
    var left = document.createElement('div');
    left.className = 'gen-left';
    var preview = document.createElement('div');
    preview.className = 'gen-preview';
    preview.id = 'gen-preview';
    left.appendChild(preview);

    // ---- 右栏：输入 + 样式 + 动作 ----
    var right = document.createElement('div');
    right.className = 'gen-right';

    ta = document.createElement('textarea');
    ta.id = 'gen-input';
    ta.className = 'gen-textarea';
    ta.placeholder = T.generatePlaceholder;
    ta.addEventListener('input', function () { render(); saveDraft(ta.value); });

    errEl = document.createElement('div');
    errEl.className = 'gen-error';
    errEl.id = 'gen-error';
    errEl.hidden = true;

    // 样式行：点阵 + 定位角
    var styleRow = document.createElement('div');
    styleRow.className = 'gen-row';
    var dotSel = document.createElement('select');
    dotSel.id = 'gen-dots';
    dotSel.className = 'gen-select';
    dotSel.appendChild(optionList(DOT_STYLES));
    var cornerSel = document.createElement('select');
    cornerSel.id = 'gen-corners';
    cornerSel.className = 'gen-select';
    cornerSel.appendChild(optionList(CORNER_STYLES));
    styleRow.appendChild(labeled(T.generateDotsStyle, dotSel));
    styleRow.appendChild(labeled(T.generateCornerStyle, cornerSel));

    // 颜色行：前景 + 背景
    var colorRow = document.createElement('div');
    colorRow.className = 'gen-row';
    var fg = document.createElement('input');
    fg.type = 'color';
    fg.id = 'gen-fg';
    fg.className = 'gen-color';
    fg.value = '#000000';
    var bg = document.createElement('input');
    bg.type = 'color';
    bg.id = 'gen-bg';
    bg.className = 'gen-color';
    bg.value = '#ffffff';
    colorRow.appendChild(labeled(T.generateFgColor, fg));
    colorRow.appendChild(labeled(T.generateBgColor, bg));

    // logo 行：上传 + 缩略图 + 移除
    var logoRow = document.createElement('div');
    logoRow.className = 'gen-row';
    var logoFile = document.createElement('input');
    logoFile.type = 'file';
    logoFile.id = 'gen-logo-file';
    logoFile.accept = 'image/*';
    logoFile.hidden = true;
    var logoBtn = document.createElement('button');
    logoBtn.className = 'mini-btn';
    logoBtn.textContent = T.generateLogo;
    logoBtn.type = 'button';
    logoBtn.addEventListener('click', function () { logoFile.click(); });
    logoFile.addEventListener('change', function () {
      var f = logoFile.files && logoFile.files[0];
      logoFile.value = ''; // 允许重复选择同一文件
      onLogoFile(f);
    });
    logoThumb = document.createElement('img');
    logoThumb.className = 'gen-logo-thumb';
    logoThumb.id = 'gen-logo-thumb';
    logoThumb.alt = '';
    logoThumb.hidden = true;
    logoRemove = document.createElement('button');
    logoRemove.className = 'mini-btn';
    logoRemove.id = 'gen-logo-remove';
    logoRemove.textContent = T.generateLogoRemove;
    logoRemove.type = 'button';
    logoRemove.hidden = true;
    logoRemove.addEventListener('click', function () {
      logoData = null;
      renderLogoState();
      render();
    });
    logoRow.appendChild(logoBtn);
    logoRow.appendChild(logoFile);
    logoRow.appendChild(logoThumb);
    logoRow.appendChild(logoRemove);

    // 动作行：下载 PNG + 复制图片
    var actions = document.createElement('div');
    actions.className = 'gen-actions';
    dlBtn = document.createElement('button');
    dlBtn.className = 'mini-btn';
    dlBtn.id = 'gen-download';
    dlBtn.type = 'button';
    dlBtn.textContent = T.btnDownloadPng;
    dlBtn.addEventListener('click', function () {
      if (!lastRenderOk) return;
      qr.download({ name: 'qr2link', extension: 'png' }); // data-URI anchor，扩展页可用
    });
    copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.id = 'gen-copy';
    copyBtn.type = 'button';
    copyBtn.textContent = T.btnCopyImage;
    copyBtn.addEventListener('click', onCopyImage);
    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);

    right.appendChild(ta);
    right.appendChild(errEl);
    right.appendChild(styleRow);
    right.appendChild(colorRow);
    right.appendChild(logoRow);
    right.appendChild(actions);

    layout.appendChild(left);
    layout.appendChild(right);
    root.appendChild(layout);

    // 样式控件变化 → 重渲染（select 用 change、color 用 input 实时）
    dotSel.addEventListener('change', render);
    cornerSel.addEventListener('change', render);
    fg.addEventListener('input', render);
    bg.addEventListener('input', render);

    // 初始即建实例（data 为空 → 容器为空，动作禁用）。append 先挂容器，
    // 后续 update() 自动清容器重画并回挂（库内 _clearContainer → append 链）
    lastRenderOk = false;
    setActionsEnabled(false);
    qr = new QRCodeStyling(baseOptions());
    qr.append(preview);
  }

  function labeled(labelText, control) {
    var wrap = document.createElement('label');
    wrap.className = 'gen-field';
    var l = document.createElement('span');
    l.className = 'gen-field-label';
    l.textContent = labelText;
    wrap.appendChild(l);
    wrap.appendChild(control);
    return wrap;
  }

  // ---------------- 渲染 ----------------

  function baseOptions() {
    return {
      type: 'canvas',
      width: QR_SIZE,
      height: QR_SIZE,
      margin: 12, // 亮边（quiet zone，扫描友好）
      qrOptions: { typeNumber: 0, errorCorrectionLevel: 'M' }, // 显式定死：库默认 Q，容量行为需可预测
      imageOptions: { hideBackgroundDots: true, imageSize: 0.4, margin: 6, crossOrigin: 'anonymous' },
      data: '',
    };
  }

  function currentOptions() {
    var fg = document.getElementById('gen-fg').value;
    var bg = document.getElementById('gen-bg').value;
    var dots = document.getElementById('gen-dots').value;
    var corners = document.getElementById('gen-corners').value;
    var o = baseOptions();
    o.data = ta.value;
    o.dotsOptions = { type: dots, color: fg };
    o.cornersSquareOptions = { type: corners, color: fg };
    o.cornersDotOptions = { type: CORNER_DOT_MAP[corners] || 'dot', color: fg };
    o.backgroundOptions = { color: bg };
    // update() 是合并语义（键缺省 = 保留旧值）：移除 logo 必须显式传空串覆盖
    o.image = logoData || '';
    return o;
  }

  function render() {
    errEl.hidden = true;
    errEl.textContent = '';
    try {
      // update()：data 为空 → 仅清空容器；超容量 → qrcode-generator 同步抛错
      //（_clearContainer 先行，容器已无残留旧码）
      qr.update(currentOptions());
      lastRenderOk = ta.value !== '';
    } catch (e) {
      lastRenderOk = false;
      showError(T.generateTooLong);
    }
    setActionsEnabled(lastRenderOk);
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  function setActionsEnabled(ok) {
    dlBtn.disabled = !ok;
    copyBtn.disabled = !ok;
  }

  function renderLogoState() {
    logoThumb.hidden = !logoData;
    logoRemove.hidden = !logoData;
    if (logoData) logoThumb.src = logoData; // 本地 file 的 dataURL，零网络
  }

  // ---------------- logo 上传边界 ----------------

  function onLogoFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type)) { // accept 属性只约束选择器，类型以 file.type 复核
      showError(T.generateLogoNotImage);
      return;
    }
    if (f.size > LOGO_MAX_BYTES) {
      showError(T.generateLogoTooLarge);
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { showError(T.generateLogoNotImage); };
    reader.onload = function () {
      // 解码预检：MIME 声称是图片但解不了码（损坏/不支持的格式）时，库的 loadImage 会
      // 拒绝 → 预览空白却仍可导出。先用 Image 实测可解码再接纳为 logo
      var dataUrl = reader.result;
      var probe = new Image();
      probe.onload = function () {
        logoData = dataUrl;
        renderLogoState();
        render();
      };
      probe.onerror = function () { showError(T.generateLogoNotImage); };
      probe.src = dataUrl;
    };
    reader.readAsDataURL(f);
  }

  // ---------------- 复制图片 ----------------

  function onCopyImage() {
    if (!lastRenderOk) return;
    qr.getRawData('png').then(function (blob) {
      if (!blob) throw new Error('no canvas');
      // clipboardWrite 权限已有（manifest）；写入 PNG 而非文本，与「复制」按钮分工
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }).then(function () {
      flashBtn(copyBtn, T.copied);
    }, function () {
      flashBtn(copyBtn, T.copyFailed); // 写入被拒也要有反馈（与 copyText 同哲学）
    });
  }

  function flashBtn(btn, msg) {
    var orig = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('flash');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('flash');
    }, 1200);
  }

  // ---------------- 草稿与预填 ----------------

  function saveDraft(text) {
    // 即时写：popup 任意时刻失焦关闭都不丢草稿（不设防抖 —— storage.session 为
    // 内存级，写频无持久化损耗；方案拍板其配额失败场景不可靠触发，不做失败分支）
    var payload = {};
    payload[DRAFT_KEY] = text;
    chrome.storage.session.set(payload);
  }

  function loadDraftOrPrefill() {
    chrome.storage.session.get(DRAFT_KEY).then(function (o) {
      if (Object.prototype.hasOwnProperty.call(o, DRAFT_KEY)) {
        // 有草稿（含空串 —— 用户显式清空过）→ 恢复，不预填
        ta.value = o[DRAFT_KEY];
        render();
        return;
      }
      prefillFromActiveTab();
    }, prefillFromActiveTab);
  }

  function prefillFromActiveTab() {
    // popup 打开即有 activeTab：可读当前标签页 url，无需 tabs 权限（V1.2-PLAN PR-3）
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var url = tabs && tabs[0] && tabs[0].url || '';
      if (/^https?:/i.test(url)) {
        ta.value = url; // 预填不落草稿：未编辑即关 → 下次重新预填当时的页面
        render();
      }
      // chrome:// 等特殊页 / 无 URL / 非 http(s) → 保持为空，占位提示即引导
    }, function () { /* 查询失败 → 留空，占位提示兜底 */ });
  }

  // ---------------- 对外 API ----------------

  /**
   * 进入生成视图（幂等）：首次构建 UI 并恢复草稿/预填；重复进入不重置用户输入。
   */
  function open() {
    if (!built) {
      build();
      built = true;
    }
    if (!draftLoaded) {
      draftLoaded = true;
      loadDraftOrPrefill();
    }
  }

  /**
   * 诊断探针（沿 QR2Link.getLastDecodeStats 先例，产品逻辑不依赖）：当前预览绘制完成的
   * promise。QRCodeStyling 的 canvas 绘制是异步的（SVG → Image → drawImage），
   * e2e 需据此等像素稳定后再比对 canvas 内容。
   */
  function whenDrawn() {
    var p = qr && qr._canvasDrawingPromise;
    var noop = function () {};
    return p ? p.then(noop, noop) : Promise.resolve();
  }

  window.Generate = { open: open, __whenDrawn: whenDrawn };
})();
