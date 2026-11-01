/**
 * popup/crop.js — 预览 + 框选裁剪组件（DESIGN §4.1）
 *
 * window.Crop.openCrop(blob) → Promise<decision>，渲染于 popup.html 固定节点 #crop-root：
 *   decision = { action: 'full' }                       「全图识别」
 *            | { action: 'crop', rect: {x,y,w,h} }      「识别所选区域」（已换算为原图坐标）
 *            | { action: 'cancel' }                     popup「返回」按钮 / Esc 调用 Crop.cancel()
 *            | { action: 'error' }                      图片加载失败
 *
 * 坐标换算：scale = img.naturalWidth / img.clientWidth（max-width/max-height 等比缩放，
 * 比例各向一致），原图矩形 = CSS 矩形 × scale。组件自带操作按钮，resolve 后自动清理 DOM。
 * 交互：空白处拖拽画新框；框内拖拽移动；四角手柄调整大小；小于 8px 视为误点清除。
 */
(function () {
  'use strict';

  var T = self.I18N;
  var MIN_CSS_PX = 8;   // 误点判定阈值（CSS 像素）
  var HANDLE_SIZE = 12; // 与 popup.css .crop-handle 保持一致

  var current = null;   // { cancel } 当前挂起实例

  function cancel() {
    if (current) current.cancel();
  }

  /**
   * 打开预览框选。blob 为待识别图片；Promise 决策见文件头注释。
   */
  function openCrop(blob) {
    cancel(); // 上一个未决实例先按取消收尾

    var root = document.getElementById('crop-root');
    return new Promise(function (resolve) {
      var objectUrl = URL.createObjectURL(blob);
      var settled = false;

      function finish(decision) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(objectUrl);
        root.textContent = '';
        current = null;
        resolve(decision);
      }
      current = { cancel: function () { finish({ action: 'cancel' }); } };

      // ---- DOM ----
      var hint = document.createElement('p');
      hint.className = 'crop-hint';
      hint.textContent = T.cropHint;

      var stage = document.createElement('div');
      stage.className = 'crop-stage';
      var img = document.createElement('img');
      img.alt = '';
      var overlay = document.createElement('div');
      overlay.className = 'crop-overlay';
      var selBox = document.createElement('div');
      selBox.className = 'crop-sel';
      selBox.hidden = true;
      stage.appendChild(img);
      stage.appendChild(overlay);
      overlay.appendChild(selBox);

      // 四角手柄：0=左上 1=右上 2=左下 3=右下
      var handles = [];
      for (var i = 0; i < 4; i++) {
        var h = document.createElement('div');
        h.className = 'crop-handle';
        h.dataset.corner = String(i);
        h.hidden = true;
        overlay.appendChild(h);
        handles.push(h);
      }

      var actions = document.createElement('div');
      actions.className = 'crop-actions';
      var btnFull = document.createElement('button');
      btnFull.className = 'ghost';
      btnFull.textContent = T.btnScanFull;
      var btnCrop = document.createElement('button');
      btnCrop.textContent = T.btnScanCrop;
      btnCrop.disabled = true;
      actions.appendChild(btnFull);
      actions.appendChild(btnCrop);

      root.appendChild(hint);
      root.appendChild(stage);
      root.appendChild(actions);

      // ---- 选区（CSS 像素，相对 overlay） ----
      var sel = null; // {x, y, w, h}

      function imgScale() {
        return img.clientWidth ? img.naturalWidth / img.clientWidth : 1;
      }

      function renderSel() {
        if (!sel) {
          selBox.hidden = true;
          handles.forEach(function (x) { x.hidden = true; });
          btnCrop.disabled = true;
          return;
        }
        selBox.hidden = false;
        btnCrop.disabled = false;
        selBox.style.left = sel.x + 'px';
        selBox.style.top = sel.y + 'px';
        selBox.style.width = sel.w + 'px';
        selBox.style.height = sel.h + 'px';
        var pts = [
          [sel.x, sel.y],
          [sel.x + sel.w, sel.y],
          [sel.x, sel.y + sel.h],
          [sel.x + sel.w, sel.y + sel.h],
        ];
        handles.forEach(function (x, i) {
          x.hidden = false;
          x.style.left = pts[i][0] - HANDLE_SIZE / 2 + 'px';
          x.style.top = pts[i][1] - HANDLE_SIZE / 2 + 'px';
        });
      }

      function setSel(x0, y0, x1, y1) {
        var W = overlay.clientWidth || 0;
        var H = overlay.clientHeight || 0;
        var xA = Math.max(0, Math.min(x0, x1));
        var xB = Math.min(W, Math.max(x0, x1));
        var yA = Math.max(0, Math.min(y0, y1));
        var yB = Math.min(H, Math.max(y0, y1));
        sel = { x: xA, y: yA, w: Math.max(0, xB - xA), h: Math.max(0, yB - yA) };
        renderSel();
      }

      function localPt(e) {
        var r = overlay.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      function cornerPoint(idx) {
        // 手柄 idx 的对角点坐标（resize 的固定锚）
        if (!sel) return null;
        switch (idx) {
          case 0: return { x: sel.x + sel.w, y: sel.y + sel.h };
          case 1: return { x: sel.x, y: sel.y + sel.h };
          case 2: return { x: sel.x + sel.w, y: sel.y };
          default: return { x: sel.x, y: sel.y };
        }
      }

      // ---- 指针交互 ----
      var drag = null; // {mode:'draw'|'move'|'resize', ...}

      overlay.addEventListener('pointerdown', function (e) {
        if (!img.clientWidth) return; // 图片未就绪
        e.preventDefault();
        overlay.setPointerCapture(e.pointerId);
        var pt = localPt(e);
        if (e.target.classList.contains('crop-handle')) {
          var anchor = cornerPoint(Number(e.target.dataset.corner));
          drag = { mode: 'resize', anchor: anchor };
        } else if (sel && pt.x >= sel.x && pt.x <= sel.x + sel.w && pt.y >= sel.y && pt.y <= sel.y + sel.h) {
          drag = { mode: 'move', start: pt, orig: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } };
        } else {
          drag = { mode: 'draw', start: pt };
        }
      });

      overlay.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var pt = localPt(e);
        var W = overlay.clientWidth || 0;
        var H = overlay.clientHeight || 0;
        if (drag.mode === 'draw') {
          setSel(drag.start.x, drag.start.y, pt.x, pt.y);
        } else if (drag.mode === 'resize' && drag.anchor) {
          setSel(drag.anchor.x, drag.anchor.y, pt.x, pt.y);
        } else if (drag.mode === 'move') {
          var dx = pt.x - drag.start.x;
          var dy = pt.y - drag.start.y;
          sel = {
            x: Math.max(0, Math.min(drag.orig.x + dx, W - drag.orig.w)),
            y: Math.max(0, Math.min(drag.orig.y + dy, H - drag.orig.h)),
            w: drag.orig.w,
            h: drag.orig.h,
          };
          renderSel();
        }
      });

      function endDrag() {
        if (drag && drag.mode === 'draw' && sel && (sel.w < MIN_CSS_PX || sel.h < MIN_CSS_PX)) {
          sel = null; // 误点清除选区
          renderSel();
        }
        drag = null;
      }
      overlay.addEventListener('pointerup', endDrag);
      overlay.addEventListener('pointercancel', endDrag);

      // ---- 操作按钮 ----
      btnFull.addEventListener('click', function () { finish({ action: 'full' }); });
      btnCrop.addEventListener('click', function () {
        if (!sel) return; // 按钮已禁用，防御兜底
        var s = imgScale();
        finish({
          action: 'crop',
          rect: {
            x: Math.round(sel.x * s),
            y: Math.round(sel.y * s),
            w: Math.round(sel.w * s),
            h: Math.round(sel.h * s),
          },
        });
      });

      // ---- 加载 ----
      img.onload = function () { renderSel(); };
      img.onerror = function () { finish({ action: 'error' }); };
      img.src = objectUrl;
    });
  }

  window.Crop = { openCrop: openCrop, cancel: cancel };
})();
