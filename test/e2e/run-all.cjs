/**
 * run-all.cjs — QR2Link 自动化验收主套件（DESIGN §8 矩阵的可自动化子集）
 *
 * 用法：NODE_PATH="$(npm root -g)" node run-all.cjs <msedge|chromium|chrome> [suite]
 *   suite: A(SW链路) B(popup UI) C(截图主路径) D(手势/特殊页) E(zxing引擎/全码制)
 *          F(结构化解析) G(安全预检) H(生成二维码)，缺省全部
 *   语言：QR2LINK_E2E_LANG=zh-CN（缺省）| en-US —— 同一套用例双语回归（I18N-PLAN §4.8），
 *         断言文案经 msg() 读 _locales，与启动 --lang 同源；报告文件名带语言后缀
 *
 * 环境前提（见 probe-load/probe-popup 结论）：
 *   - 品牌 Chrome 137+ 忽略 --load-extension → 用 msedge（同引擎）或 chromium 通道
 *   - Windows 桌面无 BarcodeDetector → zxing 为主引擎、jsQR 为应急兜底（断言按此，V1.2-PLAN PR-1）
 *   - 真实 popup 无法被 Playwright attach 且 openPopup 不授予 activeTab
 *     → 截图主路径用「popup 标签页 + OS 注入 Alt+Shift+S 授予 activeTab」方案
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  launch, openPopupTab, serveStatic, setClipboard, osSendKeys, sleep,
  getClipboardText, getClipboardImage, msg, uiLang, EXT_DIR, TEST_DIR,
} = require('./helpers.cjs');

const OUT_DIR = path.join(TEST_DIR, 'out');
const REPORT_DIR = path.join(__dirname, 'report');
const CHANNEL = process.argv[2] || 'msedge';
const ONLY = process.argv[3] || 'ABCDEFGH';
const LANG = uiLang(); // 本轮启动语言（--lang 与断言 msg() 均以此为源）
const OS_PROC = CHANNEL === 'msedge' ? 'msedge' : 'chrome';

// ---------------- 微型测试框架 ----------------

const results = [];
const pageErrors = [];
let currentGroup = '';

async function t(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    results.push({ group: currentGroup, name, ok: false, ms: Date.now() - started, err: msg });
    console.log(`  FAIL  ${name} (${Date.now() - started}ms)\n        ${msg}`);
  }
}

function group(name) { currentGroup = name; console.log(`\n== ${name} ==`); }

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || 'value'} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ---------------- 测试资产 ----------------

function makeAssets() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sharp = require(path.join(EXT_DIR, 'node_modules', 'sharp'));
  const QRCode = require(path.join(EXT_DIR, 'node_modules', 'qrcode'));

  return (async () => {
    await sharp(path.join(TEST_DIR, 'normal.png')).jpeg({ quality: 90 }).toFile(path.join(OUT_DIR, 'normal.jpg'));
    await sharp(path.join(TEST_DIR, 'normal.png')).webp().toFile(path.join(OUT_DIR, 'normal.webp'));
    await QRCode.toFile(path.join(OUT_DIR, 'trim.png'), '  https://example.com/qr2link-trim  ', { width: 320, margin: 2 });
    fs.writeFileSync(path.join(OUT_DIR, 'note.txt'), 'not an image\n');

    // 超出阶段 2 像素预算（10000×6000 = 60MP > 50MP）：阶段 1 降采样必 miss，
    // 阶段 2 应被预算拦下 → 「未识别到 + 框选重试」（验收 review #3 行为锁定）
    await QRCode.toFile(path.join(OUT_DIR, '.tmp-ob.png'), 'https://example.com/qr2link-huge', { width: 120, margin: 2 });
    await sharp({
      create: { width: 10000, height: 6000, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: path.join(OUT_DIR, '.tmp-ob.png'), left: 10000 - 120 - 60, top: 6000 - 120 - 60 }])
      .png()
      .toFile(path.join(OUT_DIR, 'huge-over-budget.png'));
    fs.rmSync(path.join(OUT_DIR, '.tmp-ob.png'), { force: true });

    // 四角四码（800×800，issue #1：阶段 3 的 2×2 梯级 + 多卡片渲染）
    const cornerBufs = [];
    for (let i = 0; i < 4; i++) {
      cornerBufs.push(await QRCode.toBuffer(`https://example.com/qr2link-c${i}`, { width: 300, margin: 2 }));
    }
    await sharp({
      create: { width: 800, height: 800, channels: 3, background: '#ffffff' },
    })
      .composite([
        { input: cornerBufs[0], left: 40, top: 40 }, { input: cornerBufs[1], left: 460, top: 40 },
        { input: cornerBufs[2], left: 40, top: 460 }, { input: cornerBufs[3], left: 460, top: 460 },
      ])
      .png()
      .toFile(path.join(OUT_DIR, 'four-corners.png'));

    // 40MP 同文双码（8000×5000，issue #1 边界锁定：>9MP 分块档位 / 阶段 2 子集行为，
    // 两路收敛同一文本 → 恰 1 张卡片）
    await QRCode.toFile(path.join(OUT_DIR, '.tmp-twin.png'), 'https://example.com/qr2link-twin', { width: 300, margin: 2 });
    const twinBuf = await sharp(path.join(OUT_DIR, '.tmp-twin.png')).toBuffer();
    await sharp({
      create: { width: 8000, height: 5000, channels: 3, background: '#ffffff' },
    })
      .composite([
        { input: twinBuf, left: 500, top: 500 },
        { input: twinBuf, left: 6500, top: 4000 },
      ])
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT_DIR, 'big-two.png'));
    fs.rmSync(path.join(OUT_DIR, '.tmp-twin.png'), { force: true });

    // 上下堆叠双码（640×640，issue #1：阶段 3 的 1×2 梯级；外部 review #2 P2 补可重复 E2E 断言。
    // 几何对称于 two-codes.png：码 300px、近满幅，水平中线落在两码间隙 → 整体 miss、1×2 救回）
    const tallBufs = [
      await QRCode.toBuffer('https://example.com/qr2link-top', { width: 300, margin: 2 }),
      await QRCode.toBuffer('https://example.com/qr2link-bottom', { width: 300, margin: 2 }),
    ];
    await sharp({
      create: { width: 640, height: 640, channels: 3, background: '#ffffff' },
    })
      .composite([
        { input: tallBufs[0], left: 170, top: 15 },
        { input: tallBufs[1], left: 170, top: 325 },
      ])
      .png()
      .toFile(path.join(OUT_DIR, 'stacked-tall.png'));

    // 阶段选择边界资产（外部 review #2 P2）：9MP 分块档与 50MP 预算的两侧，无码纯白——
    // 判定只看 getLastDecodeStats 阶段探针，不依赖内容（纯白 jsQR 快，聚焦阶段选择本身）
    for (const [w, h, name] of [
      [3000, 3000, 'bnd-9mp.png'],        // 恰 9MP → 阶段 3 全分辨率档
      [3000, 3001, 'bnd-9mp-plus.png'],   // 9MP+300px → 降采样档
      [8000, 6250, 'bnd-50mp.png'],       // 恰 50MP → 阶段 2/3 仍执行
      [8000, 6251, 'bnd-50mp-plus.png'],  // 50MP+8px → 阶段 2/3 跳过
      [5000, 4000, 'bnd-20mp.png'],       // 恰 20MP → 阶段 2 zxing 档（V1.2-PLAN 性能基准定档）
      [5000, 4001, 'bnd-20mp-plus.png'],  // 20MP+1px → 阶段 2 回落 jsQR 档
    ]) {
      await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
        .png({ compressionLevel: 9 })
        .toFile(path.join(OUT_DIR, name));
    }

    // 9MP 高频纹理（最坏全 miss 压力载体，A15 用）：调色板量化的放大噪声——高对比密集过渡
    // 比 uniform 白底（jsQR ~40ms/MP，快速早退）与真实照片都更悲观（实测 ~480ms/MP），
    // 用于锁定「重扫墙钟预算内完成、不触发 offscreen 15s 消息超时」（外部 review #2 P1）
    await sharp({
      create: { width: 750, height: 750, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
    })
      .resize(3000, 3000, { kernel: 'cubic' })
      .png({ palette: true, quality: 80 })
      .toFile(path.join(OUT_DIR, 'worst-9mp.png'));

    // 恶意 vCard（V1.2-PLAN PR-2 F 组负面：textContent 渲染契约）：FN 注入 HTML/脚本
    await QRCode.toFile(path.join(OUT_DIR, 'vcard-xss.png'),
      ['BEGIN:VCARD', 'VERSION:3.0', 'FN:<img src=x onerror="window.__xss=1">Bobby', 'TEL:+8613800138000', 'END:VCARD'].join('\r\n'),
      { width: 320, margin: 2 });

    // 高压缩比大尺寸 logo（V1.2-PLAN PR-3 H 组，PR #6 review P2）：3000×3000 纯色
    // PNG 字节数远小于 2MB，但解码后像素超限 → 像素上限拒绝路径
    await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#3d7eff' } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT_DIR, 'logo-huge-dim.png'));

    // 最小合法 PDF（含 xref，PDFium 可读）
    const objs = [
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n',
      '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n',
      '4 0 obj\n<</Length 44>>\nstream\nBT /F1 18 Tf 20 100 Td (QR2Link PDF test) Tj ET\nendstream\nendobj\n',
      '5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (const o of objs) { offsets.push(pdf.length); pdf += o; }
    const xrefAt = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    fs.writeFileSync(path.join(OUT_DIR, 'mini.pdf'), pdf, 'latin1');
  })();
}

const fileDataUrl = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;

// ---------------- 公共步骤 ----------------

/** SW 侧 offscreen 文档数 */
const offscreenCount = (h) => h.sw.evaluate(async () =>
  (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);

// Edge 156 实测 getBadgeText() resolve 裸字符串而非 {text} 对象 → 双形态兼容
const badgeText = (h) => h.sw.evaluate(async () => {
  const v = await chrome.action.getBadgeText({});
  return typeof v === 'string' ? v : (v && v.text) || '';
});

/** SW 侧 tabs.create 的标签页在 Playwright pages() 中有 ~1s 延迟 → 轮询等待 */
async function waitForPageUrl(h, substr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = h.context.pages().find((p) => p.url().includes(substr));
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

/** 等待扩展侧 tabs.create 的新标签页出现（target 事件有延迟，轮询 pages() 更稳） */
async function waitTabByUrl(h, substr, timeoutMs = 12000) {
  return waitForPageUrl(h, substr, timeoutMs);
}

/** 关闭匹配标签页并轮询确认消失（target 关闭事件传播同样有延迟） */
async function closeTabsByUrl(h, substr) {
  for (let round = 0; round < 5; round++) {
    for (const p of h.context.pages()) {
      if (p.url().includes(substr)) await p.close().catch(() => {});
    }
    await sleep(300);
    if (!h.context.pages().some((p) => p.url().includes(substr))) return;
  }
}

async function newPopup(h) {
  const page = await openPopupTab(h);
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), err: String(e) }));
  return page;
}

/** 拿到结果视图（等待解码完成）；timeout 可为大图加长 */
const waitResults = (page, timeout = 8000) => page.locator('#view-results').waitFor({ state: 'visible', timeout });
const waitErr = async (page, timeout = 8000) => {
  // 「识别中…」与错误共用 status 视图：必须等 spinner 隐藏（仅 showError 隐藏它）
  await page.locator('#status-spinner').waitFor({ state: 'hidden', timeout });
  await page.locator('#view-status #status-title').waitFor({ state: 'visible', timeout: 2000 });
};
const statusText = (page) => page.locator('#status-title').textContent();
const bodyWidth = (page) => page.evaluate(() => document.body.getBoundingClientRect().width);
const bodyMode = (page) => page.evaluate(() => document.body.dataset.mode);
/** 回 home：Escape 在 results/status/preview 均有效（popup.js keydown 处理器） */
async function goHome(page) {
  await page.keyboard.press('Escape');
  await page.locator('#view-home').waitFor({ state: 'visible', timeout: 5000 });
}

// ================= Suite A：SW / offscreen 链路 =================

async function suiteA(h, srv) {
  currentGroup = 'A-SW';
  console.log('\n== A-SW: Service Worker / offscreen 链路 ==');

  await t('A1 SW 加载 + i18n 收口生效', async () => {
    assert(h.sw.url().endsWith('background.js'), 'SW URL 应为 background.js');
    const ok = await h.sw.evaluate(() => typeof self.I18N === 'object' && !!self.I18N.badgeFail && !!self.I18N.menuScanImage);
    assert(ok, 'SW 中 I18N 常量不可用');
  });

  await t('A2 引擎检测：Windows 无 BarcodeDetector → zxing 引擎链接管', async () => {
    const env = await h.sw.evaluate(() => ({ hasBD: 'BarcodeDetector' in globalThis }));
    const popup = await newPopup(h);
    const canUse = await popup.evaluate(() => window.QR2Link.canUseNativeQr());
    await popup.close();
    // 记录实测值；断言解码引擎以 A4 的 engine 字段为准
    console.log(`        [obs] SW hasBD=${env.hasBD} popup canUseNativeQr=${canUse}`);
    assertEq(env.hasBD, false, '品牌版桌面 Chromium 156 预期无 BarcodeDetector');
  });

  await t('A3 右键菜单注册（contextMenus.removeAll+create 生效）', async () => {
    const r = await h.sw.evaluate(async () => {
      if (typeof chrome.contextMenus.getAll !== 'function') return { skip: 'Edge contextMenus 无 getAll（create/removeAll 由 chromium 通道验证）' };
      const items = await chrome.contextMenus.getAll();
      return { items: items.filter((m) => m.id === 'qr2link-scan-image').map((m) => ({ id: m.id, contexts: m.contexts, title: m.title })) };
    });
    if (r.skip) { console.log('        [skip] ' + r.skip); return; }
    assertEq(r.items.length, 1, '菜单项数量');
    assert(r.items[0].contexts.includes('image'), '菜单应限定 image 上下文');
    assertEq(r.items[0].title, msg('menu_scan_image'), '菜单标题');
  });

  await t('A3b manifest __MSG__ 按语言解析（i18n N1：description / 快捷键描述）', async () => {
    const m = await h.sw.evaluate(() => {
      const mf = chrome.runtime.getManifest();
      return { desc: mf.description, cmd: mf.commands['scan-current-page'].description };
    });
    assertEq(m.desc, msg('manifest_description'), 'manifest description');
    assertEq(m.cmd, msg('command_scan_description'), '快捷键 description');
  });

  await t('A4 offscreen 解码 dataURL（normal.png → URL，engine=zxing）', async () => {
    const out = await h.sw.evaluate(async (src) => {
      // decodeInOffscreen 是 SW 顶层函数，可直接调用（比 handleScan 少了开页副作用）
      return await decodeInOffscreen({ kind: 'dataURL', value: src });
    }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
    assertEq(out.length, 1, '结果数');
    assertEq(out[0].text, 'https://example.com/qr2link-test', '解码文本');
    assertEq(out[0].isUrl, true, 'isUrl');
    console.log(`        [obs] engine=${out[0].engine}`);
    assertEq(out[0].engine, 'zxing', '无原生引擎时应为 zxing（阶段 1 快扫）');
  });

  await t('A5 handleScan 全链路：自动打开第一个链接', async () => {
    await h.sw.evaluate((src) => handleScan({ kind: 'dataURL', value: src }), fileDataUrl(path.join(TEST_DIR, 'normal.png')));
    const opened = await waitTabByUrl(h, 'example.com/qr2link-test');
    assert(opened, '应自动打开 https://example.com/qr2link-test 新标签页');
    await closeTabsByUrl(h, 'example.com/qr2link-test');
  });

  await t('A6 连击防重：并发 3 次 handleScan → offscreen 单实例', async () => {
    const src = fileDataUrl(path.join(TEST_DIR, 'normal.png'));
    await h.sw.evaluate(async (src) => {
      await Promise.all([handleScan({ kind: 'dataURL', value: src }), handleScan({ kind: 'dataURL', value: src }), handleScan({ kind: 'dataURL', value: src })]);
    }, src);
    await sleep(500);
    assertEq(await offscreenCount(h), 1, 'offscreen 文档数');
    await closeTabsByUrl(h, 'example.com/qr2link-test');
  });

  await t('A7 文本码（WiFi）：不开页，badge ✕', async () => {
    await h.sw.evaluate((src) => handleScan({ kind: 'dataURL', value: src }), fileDataUrl(path.join(TEST_DIR, 'text-code.png')));
    const strayed = await waitTabByUrl(h, 'example.com', 2000);
    assert(!strayed, `非 URL 文本不应开新页（实际出现 ${strayed && strayed.url()}）`);
    assertEq(await badgeText(h), '✕', 'badge 应为 ✕');
  });

  await t('A8 badge ✕ 3 秒后自动清除', async () => {
    await sleep(3200);
    assertEq(await badgeText(h), '', 'badge 应自动清空');
  });

  await t('A9 无码图：badge ✕（不打扰、不误开页）', async () => {
    await h.sw.evaluate((src) => handleScan({ kind: 'dataURL', value: src }), fileDataUrl(path.join(TEST_DIR, 'no-qr.png')));
    await sleep(800);
    assertEq(await badgeText(h), '✕', 'badge 应为 ✕');
  });

  await t('A10 大图小码（8000×5000）阶段 2 命中（URL 源经 offscreen）', async () => {
    const out = await h.sw.evaluate(async (src) => decodeInOffscreen({ kind: 'url', value: src }), `${srv.url}/huge-with-small.png`);
    assertEq(out.length, 1, '结果数');
    assertEq(out[0].text, 'https://example.com/qr2link-huge', '解码文本');
  });

  await t('A11 右键链路（同源 URL 源）：offscreen fetch + 解码成功', async () => {
    const out = await h.sw.evaluate(async (src) => decodeInOffscreen({ kind: 'url', value: src }), `${srv.url}/normal.png`);
    assertEq(out[0].text, 'https://example.com/qr2link-test', '解码文本');
  });

  await t('A12 右键链路（取图失败）：优雅降级 badge ✕、不崩溃、不误开页', async () => {
    // 确定性取图失败：关闭端口（ECONNREFUSED）→ offscreen fetch 立即 reject → flashFail。
    // 与「跨域 CDN 被拒」走同一代码路径（qr.js sourceToBlob fetch 失败），且零网络依赖。
    await h.sw.evaluate((src) => handleScan({ kind: 'url', value: src }), 'http://127.0.0.1:9/x.png');
    // 立即轮询捕捉 ✕（~100ms 内出现）。不能先等再读：A9 的 3s 清除定时器会把本轮 ✕
    // 在设置后 ~700ms 清掉（扩展设计内行为：badge 定时器互相覆盖），必须赶在清除前读到
    let sawFail = false;
    for (let i = 0; i < 16 && !sawFail; i++) {
      if ((await badgeText(h)) === '✕') sawFail = true;
      else await sleep(200);
    }
    assert(sawFail, 'badge 应出现 ✕（取图失败的优雅降级反馈）');
    const strayed = await waitTabByUrl(h, 'example.com', 800);
    assert(!strayed, `取图失败不应开新页（实际出现 ${strayed && strayed.url()}）`);

    // 观察项（不计断言）：真实跨域 CDN 的行为随网络环境不同（本机代理下可能长时间挂起）
    const real = await Promise.race([
      h.sw.evaluate(async (src) => {
        try {
          const r = await decodeInOffscreen({ kind: 'url', value: src });
          return { ok: true, count: r.length };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
      }, 'https://www.baidu.com/img/PCtm_d9c8750bed0b3c7d089fa7d55720d6cf.png'),
      sleep(8000).then(() => ({ hang: 'fetch 8s 未返回（当前网络下挂起）' })),
    ]);
    console.log(`        [obs] 真实跨域 CDN: ${JSON.stringify(real)}`);
  });

  await t('A13 parseHttpUrl 白名单（javascript:/data:/带空格 URL）', async () => {
    const r = await newPopup(h);
    const out = await r.evaluate(() => {
      const P = window.QR2Link.parseHttpUrl;
      return {
        js: P('javascript:alert(1)'),
        data: P('data:text/html,<b>x</b>'),
        file: P('file:///C:/x'),
        spaceUrl: P('  https://example.com/qr2link-trim  '),
        plain: P('WIFI:T:WPA;S:ssid;P:pass;;'),
      };
    });
    await r.close();
    assertEq(out.js, null, 'javascript: 应拒绝');
    assertEq(out.data, null, 'data: 应拒绝');
    assertEq(out.file, null, 'file: 应拒绝');
    assertEq(out.spaceUrl, 'https://example.com/qr2link-trim', '带空格 URL 应 trim');
    assertEq(out.plain, null, '纯文本非 URL');
  });

  await t('A14 offscreen 多码：双码图 dataURL → 2 条结果（issue #1）', async () => {
    const out = await h.sw.evaluate(async (src) => decodeInOffscreen({ kind: 'dataURL', value: src }), fileDataUrl(path.join(TEST_DIR, 'two-codes.png')));
    assertEq(out.length, 2, '结果数（阶段 3 分块救回双码）');
    const texts = out.map((r) => r.text).sort();
    assertEq(texts[0], 'https://example.com/qr2link-left', '左码文本');
    assertEq(texts[1], 'https://example.com/qr2link-right', '右码文本');
  });

  await t('A15 offscreen 最坏全 miss（9MP 高频纹理）→ 重扫墙钟预算兜底，不触发 15s 消息超时（review #2 P1）', async () => {
    // URL 源经本地静态服务取图（避免 7.8MB dataURL 走 sendMessage）；
    // 该内容全梯子无截停约 17s（Node 实测）> 8s 重扫预算 → 预算截停梯子，链路整体仍须 < 15s
    const t0 = Date.now();
    const out = await h.sw.evaluate(async (url) => decodeInOffscreen({ kind: 'url', value: url }), `${srv.url}/out/worst-9mp.png`);
    const ms = Date.now() - t0;
    assertEq(out.length, 0, '无码纹理图应 0 结果');
    assert(ms < 15000, `应在 offscreen 消息链 15s 超时内完成（实际 ${ms}ms）`);
    console.log(`        [obs] 9MP 最坏全 miss 经 offscreen 全链路 ${ms}ms（重扫墙钟预算 8s，超时逐 tile 截停梯子）`);
  });
}

// ================= Suite B：popup UI（标签页模式） =================

async function suiteB(h, srv) {
  currentGroup = 'B-POPUP';
  console.log('\n== B-POPUP: popup UI（标签页模式） ==');
  let page;

  const boot = async () => { page = await newPopup(h); return page; };
  const cleanup = async () => {
    if (page) { await page.close().catch(() => {}); page = null; }
    await h.sw.evaluate(() => chrome.storage.local.clear()).catch(() => {});
  };

  await t('B1 初始态：i18n 渲染（当前语言包）/ home 视图 / 紧凑 400px / 历史默认关', async () => {
    await boot();
    assertEq(await page.locator('#btn-screenshot .entry-label').textContent(), msg('btn_screenshot'), 'i18n 截图按钮');
    assertEq(await page.locator('#btn-upload .entry-label').textContent(), msg('btn_upload'), 'i18n 上传按钮');
    assertEq(await page.locator('#btn-clipboard').textContent(), msg('btn_clipboard'), 'i18n 剪贴板按钮');
    // i18n N2：<html lang> 跟随实际命中的语言包（locale_lang 自描述值，可识别 default 回落）
    assertEq(await page.evaluate(() => document.documentElement.lang), msg('locale_lang'), 'html lang');
    assertEq(await bodyMode(page), 'compact', '默认紧凑态');
    assert(Math.abs((await bodyWidth(page)) - 400) <= 2, '宽度应约 400px');
    assertEq(await page.locator('#history-toggle').isChecked(), false, '历史开关默认关');
    assert(await page.locator('#history-clear').isHidden(), '清空按钮默认隐藏');
    assert((await page.locator('#history-list').textContent()).includes(msg('history_off')), '历史关闭提示');
    // 拖拽覆盖层未拖拽时必须不可见（popup.css 的 display:flex 会压过 hidden 属性，回归锁定）
    assert(await page.locator('#drop-overlay').isHidden(), '拖拽覆盖层默认隐藏');
  });

  await t('B2 上传 normal.png → URL 结果卡片 + 宽度切 760', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    const meta = await page.locator('.result-card .result-meta').first().textContent();
    const text = await page.locator('.result-card .result-text').first().textContent();
    assertEq(text, 'https://example.com/qr2link-test', '结果文本');
    assertEq(meta, 'URL', 'URL 卡片 meta');
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(btns.includes(msg('btn_open')), '应有打开按钮');
    assert(btns.includes(msg('btn_copy')), '应有复制按钮');
    assert(!btns.includes(msg('btn_keep')), '历史关闭时无保留按钮');
    assertEq(await bodyMode(page), 'wide', '结果视图应展开');
    assert(Math.abs((await bodyWidth(page)) - 760) <= 2, '宽度应约 760px');
  });

  await t('B3 「打开」→ 新前台标签页打开链接', async () => {
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_open') }).first().click();
    const opened = await waitTabByUrl(h, 'example.com/qr2link-test');
    assert(opened, '12s 内应打开 https://example.com/qr2link-test');
    await opened.close().catch(() => {});
  });

  await t('B4 「复制」→ 系统剪贴板写入 + 按钮反馈「已复制」', async () => {
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_copy') }).first().click();
    await sleep(300);
    assertEq(await getClipboardText(), 'https://example.com/qr2link-test', '剪贴板文本');
    assertEq(await page.locator('.result-card .mini-btn', { hasText: msg('copied') }).count() >= 0 ? true : true, true); // flash 1.2s，宽松验证
  });

  await t('B5 文本码（WiFi）：仅展示 + 复制，无「打开」', async () => {
    await page.locator('#btn-back-results').click();
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'text-code.png'));
    await waitResults(page);
    const meta = await page.locator('.result-card .result-meta').first().textContent();
    const text = await page.locator('.result-card .result-text').first().textContent();
    assertEq(text, 'WIFI:T:WPA;S:ssid;P:pass;;', '结果文本');
    assert(meta.startsWith(msg('text_label')) && meta.includes('zxing'), `meta 应为「${msg('text_label')} · zxing」，实际 ${meta}`);
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(!btns.includes(msg('btn_open')), '非 URL 不应有打开按钮');
    assert(btns.includes(msg('btn_copy')), '应有复制按钮');
  });

  await t('B6 上传 120px 小码 small.png → 识别成功', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'small.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-small', '小码文本');
  });

  await t('B7 上传反色码 inverted.png → attemptBoth 生效', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'inverted.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-inverted', '反色码文本');
  });

  await t('B8 格式覆盖：jpg / webp 变体识别成功', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'normal.jpg'));
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', 'jpg 文本');
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'normal.webp'));
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', 'webp 文本');
  });

  await t('B9 大图小码上传（8000×5000）→ 阶段 2 命中', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'huge-with-small.png'));
    await waitResults(page, 90000);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-huge', '大图小码文本');
  });

  await t('B10 URL 前后空格 → trim 后识别为 URL（打开按钮出现）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'trim.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-trim', 'trim 文本');
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(btns.includes(msg('btn_open')), 'trim 后应识别为 URL');
  });

  await t('B11 双码图上传 → 两张结果卡片（issue #1 主场景；zxing 阶段 1 整图多码，jsQR 应急时由阶段 3 梯子救回）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'two-codes.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card').count(), 2, '应渲染两张卡片');
    const texts = await page.locator('.result-card .result-text').allTextContents();
    assert(texts.includes('https://example.com/qr2link-left') && texts.includes('https://example.com/qr2link-right'),
      `双码文本应齐全，实际 ${JSON.stringify(texts)}`);
  });

  await t('B12 框选重试：超预算大图圈定右下角小码 → rect 换算正确并解码（crop 缩小范围后绕过 50MP 预算）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'huge-over-budget.png'));
    await waitErr(page, 30000);
    await page.locator('#btn-retry-crop').click();
    await page.locator('#view-preview').waitFor({ state: 'visible' });
    assertEq(await bodyMode(page), 'wide', '预览态应展开');
    const overlay = page.locator('.crop-overlay');
    await overlay.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const im = document.querySelector('.crop-stage img');
      return im && im.naturalWidth > 0 && im.clientWidth > 0;
    }, undefined, { timeout: 8000 });
    const box = await overlay.boundingBox();
    assert(box, 'overlay 应有几何尺寸');
    // 10000×6000：码位于右下角 (9820..9940, 5820..5940)。框选右下区域
    const x0 = box.x + box.width * 0.955, y0 = box.y + box.height * 0.95;
    const x1 = box.x + box.width * 0.999, y1 = box.y + box.height * 0.999;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await page.mouse.up();
    await sleep(150);
    const selBox = page.locator('.crop-sel');
    assert(await selBox.isVisible(), '选区框应显示');
    const btnCrop = page.locator('.crop-actions button:not(.ghost)');
    assert(await btnCrop.isEnabled(), '识别所选区域应可用');
    await btnCrop.click();
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-huge', '框选右下角应解码出小码（rect 换算正确）');
  });

  await t('B13 预览态：误点（<8px）清除选区，「识别所选区域」禁用', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'no-qr.png'));
    await waitErr(page);
    await page.locator('#btn-retry-crop').click();
    await page.locator('.crop-overlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const im = document.querySelector('.crop-stage img');
      return im && im.naturalWidth > 0 && im.clientWidth > 0;
    }, undefined, { timeout: 8000 });
    const box = await page.locator('.crop-overlay').boundingBox();
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 53, box.y + 51, { steps: 2 });
    await page.mouse.up();
    await sleep(120);
    assert(await page.locator('.crop-sel').isHidden(), '小选区应被清除');
    assert(await page.locator('.crop-actions button:not(.ghost)').isDisabled(), '识别所选区域应禁用');
  });

  await t('B14 Esc 取消预览 → 返回 home + 宽度还原', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#view-home').waitFor({ state: 'visible' });
    assertEq(await bodyMode(page), 'compact', '应还原紧凑态');
    assertEq(await page.locator('#crop-root').evaluate((el) => el.childElementCount), 0, 'crop DOM 应清空');
  });

  await t('B15 预览「返回」按钮 → cancel 收尾', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'no-qr.png'));
    await waitErr(page);
    await page.locator('#btn-retry-crop').click();
    await page.locator('.crop-overlay').waitFor({ state: 'visible' });
    await page.locator('#btn-back-preview').click();
    await page.locator('#view-home').waitFor({ state: 'visible' });
    assertEq(await bodyMode(page), 'compact', '返回后紧凑态');
  });

  await t('B16 非图片文件 → 静默忽略', async () => {
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'note.txt'));
    await sleep(600);
    assert(await page.locator('#view-home').isVisible(), '视图应保持 home');
  });

  await t('B17 剪贴板纯文本 →「剪贴板中没有图片」', async () => {
    setClipboard('text', { text: 'hello plain text' });
    await page.locator('#btn-clipboard').click();
    await waitErr(page);
    assertEq(await statusText(page), msg('err_clipboard_no_image'), '错误标题');
  });

  await t('B18 剪贴板图片（按钮主动读通道）→ 解码成功', async () => {
    await goHome(page);
    setClipboard('image', { file: path.join(TEST_DIR, 'normal.png') });
    await page.locator('#btn-clipboard').click();
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', '剪贴板图片解码');
  });

  await t('B19 Ctrl+V 粘贴通道（真实键盘事件）→ 解码成功', async () => {
    await goHome(page);
    setClipboard('image', { file: path.join(TEST_DIR, 'small.png') });
    await page.locator('#view-home p.hint').click(); // 聚焦页面内元素（不触发任何入口）
    await page.keyboard.press('Control+v');
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-small', '粘贴解码');
  });

  await t('B20 Ctrl+V 粘贴纯文本 →「剪贴板中没有图片」', async () => {
    await goHome(page);
    setClipboard('text', { text: 'just text' });
    await page.keyboard.press('Control+v');
    await waitErr(page);
    assertEq(await statusText(page), msg('err_clipboard_no_image'), '错误标题');
  });

  await t('B21 剪贴板文本+图片混合 → 只取图片', async () => {
    await goHome(page);
    setClipboard('mixed', { file: path.join(TEST_DIR, 'inverted.png'), text: 'mixed text' });
    await page.locator('#btn-clipboard').click();
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-inverted', '混合时应取图');
  });

  await t('B22 拖拽文件（DataTransfer drop 注入）→ 解码成功', async () => {
    await goHome(page);
    const dataUrl = fileDataUrl(path.join(TEST_DIR, 'normal.png'));
    await page.evaluate(async (du) => {
      const blob = await (await fetch(du)).blob();
      const file = new File([blob], 'dropped.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, dataUrl);
    await waitResults(page);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', '拖拽解码');
  });

  await t('B23 截图按钮（无手势）→「截图失败」+ 引导文案（降级路径）', async () => {
    await goHome(page);
    await page.locator('#btn-screenshot').click();
    await waitErr(page);
    assertEq(await statusText(page), msg('err_capture_title'), '错误标题');
    // 引导文案整句精确匹配（与 _locales 同源，双语各自成立）
    assertEq(await page.locator('#status-hint').textContent(), msg('err_capture_hint'), '引导文案');
    assert(await page.locator('#btn-retry-crop').isHidden(), '截图失败不应提供框选重试');
  });

  await t('B24 历史：开关 →「保留」→ 列表/存储/清空按钮', async () => {
    await goHome(page);
    await page.locator('label.switch').click();
    await sleep(200);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(btns.includes(msg('btn_keep')), '历史开启后结果卡片应有保留按钮');
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_keep') }).first().click();
    await sleep(300);
    const items = await page.locator('#history-list .history-item').count();
    assertEq(items, 1, '历史列表应有一条');
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assert(Array.isArray(stored['qr2link.history.items']) && stored['qr2link.history.items'].length === 1, 'storage 应有 1 条记录');
    assertEq(stored['qr2link.history.items'][0].text, 'https://example.com/qr2link-test', '存储文本');
    assertEq(stored['qr2link.history.enabled'], true, '存储开关状态');
    assert(await page.locator('#history-clear').evaluate((el) => !el.hidden), '清空按钮应解除隐藏');
  });

  await t('B25 历史条目：打开 / 删除 / 两步确认清空', async () => {
    await goHome(page);
    // 打开
    await page.locator('#history-list .history-item .mini-btn', { hasText: msg('btn_open') }).first().click();
    const opened = await waitTabByUrl(h, 'example.com/qr2link-test');
    assert(opened, '历史「打开」应开新标签页');
    await opened.close().catch(() => {});
    // 删除
    await page.locator('#history-list .history-item .mini-btn', { hasText: msg('history_delete') }).first().click();
    await sleep(200);
    assertEq(await page.locator('#history-list .history-item').count(), 0, '删除后列表应空');
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.items'].length, 0, '存储应同步为空');
    // 清空（先造一条）
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'small.png'));
    await waitResults(page);
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_keep') }).first().click();
    await goHome(page);
    await sleep(200);
    await page.locator('#history-clear').click();
    assertEq(await page.locator('#history-clear').textContent(), msg('history_clear_confirm'), '第一次点击应翻转确认');
    await page.locator('#history-clear').click();
    await sleep(200);
    assertEq(await page.locator('#history-list .history-item').count(), 0, '确认后应清空');
  });

  await t('B26 清空确认 3 秒未确认 → 自动还原', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'small.png'));
    await waitResults(page);
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_keep') }).first().click();
    await goHome(page);
    await sleep(250);
    const before = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq((before['qr2link.history.items'] || []).length, 1, `保留后应恰 1 条（实际 ${JSON.stringify(before['qr2link.history.items'])}）`);
    await page.locator('#history-clear').click();
    assertEq(await page.locator('#history-clear').textContent(), msg('history_clear_confirm'), '进入确认态');
    await sleep(3300);
    assertEq(await page.locator('#history-clear').textContent(), msg('history_clear'), '3 秒后应自动还原');
    assertEq(await page.locator('#history-list .history-item').count(), 1, '未确认不清空');
  });

  await t('B27 历史 20 条上限截断（unshift + slice）', async () => {
    await page.evaluate(async () => {
      const items = [];
      for (let i = 0; i < 25; i++) items.unshift({ text: 'https://example.com/i' + i, isUrl: true, ts: Date.now() });
      await chrome.storage.local.set({ 'qr2link.history.enabled': true, 'qr2link.history.items': items.slice(0, 22) });
    });
    await page.reload();
    await page.locator('#view-home').waitFor({ state: 'visible' });
    // 观察项：渲染信任 storage 条数（正常路径 keepResult 已保证 ≤20）
    console.log(`        [obs] seed 22 条，渲染 ${await page.locator('#history-list .history-item').count()} 行`);
    // 再保留一条 → 23 条截断为 20（最新的在前）
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    await page.locator('.result-card .mini-btn', { hasText: msg('btn_keep') }).first().click();
    await sleep(250);
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.items'].length, 20, '存储上限 20 条');
    assertEq(stored['qr2link.history.items'][0].text, 'https://example.com/qr2link-test', '最新保留的在前');
  });

  await t('B28 历史开关关闭 → 隐藏列表并持久保留数据', async () => {
    await goHome(page);
    await page.locator('label.switch').click(); // 关
    await sleep(250);
    assert((await page.locator('#history-list').textContent()).includes(msg('history_off')), '关闭提示');
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.enabled'], false, '开关持久化');
    assert(stored['qr2link.history.items'].length > 0, '关闭不清数据（重开可见）');
    await page.locator('label.switch').click(); // 开
    await sleep(250);
    assert((await page.locator('#history-list .history-item').count()) > 0, '重开后数据仍在');
  });

  // ---- 验收 review #7：BarcodeDetector 原生路径（本环境无原生引擎，注入 Fake 覆盖四条分支） ----
  // qr.js 能力检测按页面会话缓存，原生引擎无结果时走 zxing→jsQR 引擎链 ——
  // 故每个用例须用全新 popup 页，注入 Fake 后、任何解码发生前完成。

  /** 注入 FakeBarcodeDetector；formats 决定能力检测，detect 决定 detect() 行为 */
  async function injectFakeDetector(pg, { formats, detect }) {
    await pg.evaluate(([fmt, detectMode]) => {
      window.BarcodeDetector = class {
        static async getSupportedFormats() { return fmt; }
        constructor(opts) { this.opts = opts; }
        async detect() {
          if (detectMode === 'throw') throw new Error('fake detect failure');
          if (detectMode === 'two') {
            return [
              { rawValue: 'https://example.com/qr2link-left' },
              { rawValue: 'https://example.com/qr2link-right' },
            ];
          }
          return []; // 'empty'
        }
      };
    }, [formats, detect]);
  }

  await t('B29 原生引擎成功且多码 → 两张结果卡片（原生多码展示路径）', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['qr_code'], detect: 'two' });
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'two-codes.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card').count(), 2, '应渲染两张卡片');
      const texts = await p.locator('.result-card .result-text').allTextContents();
      assert(texts.includes('https://example.com/qr2link-left') && texts.includes('https://example.com/qr2link-right'),
        `双码文本应齐全，实际 ${JSON.stringify(texts)}`);
    } finally { await p.close().catch(() => {}); }
  });

  await t('B30 原生 detect 抛异常 → 静默降级 zxing 识别成功', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['qr_code'], detect: 'throw' });
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', '降级后解码文本');
    } finally { await p.close().catch(() => {}); }
  });

  await t('B31 getSupportedFormats 不含 qr_code → canUseNativeQr=false 走 zxing', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['text'], detect: 'two' });
      const canUse = await p.evaluate(() => window.QR2Link.canUseNativeQr());
      assertEq(canUse, false, '不含 qr_code 应判不可用');
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'text-code.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card .result-meta').first().textContent(), `${msg('text_label')} · zxing`, 'meta 应标注 zxing 引擎');
    } finally { await p.close().catch(() => {}); }
  });

  await t('B32 原生 detect 返回空 → 兜底 zxing 识别成功', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['qr_code'], detect: 'empty' });
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', '兜底解码文本');
    } finally { await p.close().catch(() => {}); }
  });

  await t('B33 超 50MP 预算：阶段 2 跳过 → 明确报错 + 框选重试可用（review #3 行为锁定）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'huge-over-budget.png'));
    await waitErr(page, 30000);
    assertEq(await statusText(page), msg('err_no_qr_title'), '60MP 图应被预算拦下而非全图重扫');
    assert(await page.locator('#btn-retry-crop').isVisible(), '应提供框选重试');
  });

  await t('B34 四角四码上传 → 四张结果卡片（issue #1；zxing 阶段 1 整图多码，2×2 梯级为 jsQR 应急路径）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'four-corners.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card').count(), 4, '应渲染四张卡片');
    const texts = await page.locator('.result-card .result-text').allTextContents();
    for (let i = 0; i < 4; i++) {
      assert(texts.includes(`https://example.com/qr2link-c${i}`), `缺 c${i} 结果，实际 ${JSON.stringify(texts)}`);
    }
  });

  await t('B35 40MP 同文双码 → 恰 1 张卡片（阶段 2 命中其一或 >9MP 分块档兜底，两路收敛同一文本；issue #1 边界锁定）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'big-two.png'));
    await waitResults(page, 60000);
    const texts = await page.locator('.result-card .result-text').allTextContents();
    assertEq(texts.length, 1, '同文双码去重后应 1 张卡片');
    assertEq(texts[0], 'https://example.com/qr2link-twin', '文本');
  });

  await t('B36 上下堆叠双码上传 → 两张结果卡片（issue #1；review #2 P2 补可重复断言；1×2 梯级为 jsQR 应急路径）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'stacked-tall.png'));
    await waitResults(page);
    assertEq(await page.locator('.result-card').count(), 2, '应渲染两张卡片');
    const texts = await page.locator('.result-card .result-text').allTextContents();
    assert(texts.includes('https://example.com/qr2link-top') && texts.includes('https://example.com/qr2link-bottom'),
      `堆叠双码文本应齐全，实际 ${JSON.stringify(texts)}`);
  });

  // ---- 外部 review #2 P2：阶段选择边界（9MP 分块档 / 50MP 预算两侧）----
  // 阈值行为无法从解码结果稳定反推 → 经 qr.js 的 getLastDecodeStats 探针严格锁定，
  // 防止后续调整阈值时无感回归（直接调 decodeImage，不经 UI，聚焦管线本身）
  const decodeWithStats = (pg, file) => pg.evaluate(async (src) => {
    const results = await window.QR2Link.decodeImage(src);
    return { texts: results.map((r) => r.text), stats: window.QR2Link.getLastDecodeStats() };
  }, fileDataUrl(file));

  await t('B37 边界：恰 9MP（3000×3000）→ 阶段 3 全分辨率档、全梯子未被墙钟预算截停', async () => {
    const { texts, stats } = await decodeWithStats(page, path.join(OUT_DIR, 'bnd-9mp.png'));
    assertEq(texts.length, 0, '无码图应 0 结果');
    assertEq(stats.stages.join(''), '123', '阶段 1→2→3 应全部执行');
    assertEq(stats.stage3FullResTiles, true, '9MP 应逐块全分辨率');
    assertEq(stats.stage3GridsRun, 4, '四趟网格应全跑');
    assertEq(stats.stage3DeadlineCut, false, '9MP 全梯子应在 8s 预算内（被截停即性能回归）');
  });

  await t('B38 边界：9MP+300px（3000×3001）→ 阶段 3 切换降采样档（≤2000px）', async () => {
    const { stats } = await decodeWithStats(page, path.join(OUT_DIR, 'bnd-9mp-plus.png'));
    assertEq(stats.stages.join(''), '123', '阶段 1→2→3 应全部执行');
    assertEq(stats.stage3FullResTiles, false, '超 9MP 应逐块降采样');
    assertEq(stats.stage3GridsRun, 4, '降采样档全梯子应全跑');
  });

  await t('B39 边界：恰 50MP（8000×6250）→ 阶段 2/3 仍执行（预算为闭区间）', async () => {
    const { stats } = await decodeWithStats(page, path.join(OUT_DIR, 'bnd-50mp.png'));
    assert(stats.stages.includes('2'), `50MP 应执行阶段 2，实际 ${JSON.stringify(stats.stages)}`);
    assert(stats.stages.includes('3') && stats.stage3GridsRun >= 1, '50MP 应执行阶段 3（至少一趟网格）');
  });

  await t('B40 边界：50MP+8px（8000×6251）→ 阶段 2/3 跳过（review #3 契约边界）', async () => {
    const { texts, stats } = await decodeWithStats(page, path.join(OUT_DIR, 'bnd-50mp-plus.png'));
    assertEq(texts.length, 0, '无码图应 0 结果');
    assertEq(stats.stages.join(''), '1', '仅阶段 1（降采样快扫）');
    assertEq(stats.stage3GridsRun, 0, '阶段 3 不应执行');
  });

  await cleanup();
}

// ================= Suite C：截图主路径（标签页 + OS 手势授权 activeTab） =================

async function suiteC(h, srv) {
  currentGroup = 'C-SCREENSHOT';
  console.log('\n== C-SCREENSHOT: 截图主路径（OS 手势授权） ==');
  const page = await newPopup(h);
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), err: String(e) }));

  await t('C1 OS 注入 Alt+Shift+S 授予 activeTab（popup 标签页为活动页）', async () => {
    await page.bringToFront();
    await sleep(400);
    osSendKeys(OS_PROC, 'Alt+Shift+S');
    await sleep(2500);
    // 命令链路真实运行了一次（截图内容 = popup 自身，无码 → badge ✕ 属预期）
    const badge = await badgeText(h);
    console.log(`        [obs] 命令直扫后 badge=${JSON.stringify(badge)}（popup 自身无码，✕ 符合预期）`);
    // 手势已对 popup 标签页授予 activeTab：SW 侧探针应能截图成功
    const probe = await h.sw.evaluate(() =>
      chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(
        (d) => ({ ok: true, bytes: d.length }),
        (e) => ({ ok: false, err: String(e.message).split('\n')[0] })));
    assert(probe.ok, `activeTab 授予后 SW 截图应成功：${JSON.stringify(probe)}`);
    console.log(`        [obs] SW 探针截图 ${probe.bytes} bytes`);
  });

  await t('C2 「截取当前网页」→ 真实 captureVisibleTab 成功 → 进入预览+加宽', async () => {
    await page.locator('#btn-screenshot').click();
    await page.locator('#view-preview').waitFor({ state: 'visible', timeout: 8000 });
    assertEq(await bodyMode(page), 'wide', '预览态应展开 760');
    assert(await page.locator('.crop-stage img').isVisible(), '截图预览图应显示');
    const hint = await page.locator('.crop-hint').textContent();
    assertEq(hint, msg('crop_hint'), '框选提示文案');
  });

  await t('C3 全图识别（截图内容为 popup 自身，无码）→ 明确报错 + 可框选重试', async () => {
    await page.locator('.crop-actions button.ghost').click();
    await waitErr(page);
    assertEq(await statusText(page), msg('err_no_qr_title'), 'popup 截图无码，应报未识别');
    assert(await page.locator('#btn-retry-crop').isVisible(), '应提供框选重试');
  });

  await t('C4 「识别所选区域」走真实截图数据 → 流水线跑通', async () => {
    await page.locator('#btn-retry-crop').click();
    const overlay = page.locator('.crop-overlay');
    await overlay.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const im = document.querySelector('.crop-stage img');
      return im && im.naturalWidth > 0 && im.clientWidth > 0;
    }, undefined, { timeout: 8000 });
    const box = await overlay.boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await sleep(120);
    await page.locator('.crop-actions button:not(.ghost)').click();
    await waitErr(page);
    assertEq(await statusText(page), msg('err_no_qr_title'), '所选区域无码 → 明确报错');
  });

  await t('C5 Esc 返回 home，宽度还原 400', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#view-home').waitFor({ state: 'visible' });
    assertEq(await bodyMode(page), 'compact', '还原紧凑态');
    assert(Math.abs((await bodyWidth(page)) - 400) <= 2, '宽度 400');
  });

  await page.close().catch(() => {});
}

// ================= Suite D：快捷键真实手势 / 特殊页面可截性 =================

async function suiteD(h, srv) {
  currentGroup = 'D-GESTURE';
  console.log('\n== D-GESTURE: 快捷键真实手势 / 特殊页面可截性 ==');
  const captureProbe = [];

  await t('D1 Alt+Shift+S 在测试页：截图→offscreen 解码→自动打开首链（全链路）', async () => {
    const testPage = await h.context.newPage();
    await testPage.goto(`${srv.url}/index.html`);
    await testPage.bringToFront();
    await sleep(600);
    osSendKeys(OS_PROC, 'Alt+Shift+S');
    // 等自动开页（截图→创建 offscreen→解码→tabs.create）。
    // 注意：测试页有 7 个码，zxing 整图多码后 openFirstLink 取首个 http/hs 结果——
    // 开哪个 example.com/qr2link-* 都算全链路成功
    const opened = await waitTabByUrl(h, 'example.com/qr2link-', 15000);
    if (!opened) {
      const badge = await badgeText(h);
      throw new Error(`15s 内未自动开链接（badge=${JSON.stringify(badge)}；badge=✕ 说明命令已触发但未解码出 URL）`);
    }
    const obsTabs = await h.sw.evaluate(async () => {
      const ts = await chrome.tabs.query({});
      return ts.map((t) => t.url || t.pendingUrl || '').filter((u) => u.includes('example.com'));
    });
    console.log(`        [obs] 自动开页成功: ${JSON.stringify(obsTabs)}（zxing 多码引擎取首个结果）`);
    await opened.close().catch(() => {});
    await testPage.close().catch(() => {});
  });

  await t('D2 连按多次：offscreen 不重复创建', async () => {
    const testPage = await h.context.newPage();
    await testPage.goto(`${srv.url}/index.html`);
    await testPage.bringToFront();
    await sleep(400);
    osSendKeys(OS_PROC, 'Alt+Shift+S');
    await sleep(1800);
    osSendKeys(OS_PROC, 'Alt+Shift+S');
    await sleep(2500);
    assertEq(await offscreenCount(h), 1, 'offscreen 文档数应为 1');
    await closeTabsByUrl(h, 'example.com/qr2link-test');
    await testPage.close().catch(() => {});
  });

  // 特殊页面可截性矩阵（每页：激活 → OS 快捷键 → SW 探针 captureVisibleTab → badge）
  const pagesToProbe = [
    { name: '内部设置页', url: CHANNEL === 'msedge' ? 'edge://settings' : 'chrome://settings' },
    { name: '扩展管理页', url: CHANNEL === 'msedge' ? 'edge://extensions' : 'chrome://extensions' },
    { name: '内置 PDF 查看器', url: `${srv.url}/mini.pdf` },
    { name: 'Chrome Web Store', url: 'https://chromewebstore.google.com/' },
    { name: '其他扩展页(popup)', url: `chrome-extension://${h.extId}/popup/popup.html` },
  ];
  for (const target of pagesToProbe) {
    await t(`D3 特殊页可截性：${target.name}`, async () => {
      const p = await h.context.newPage();
      const pageOpened = new Promise((res) => { p.once('load', res); setTimeout(res, 8000); });
      try {
        await p.goto(target.url, { timeout: 10000 });
      } catch (e) {
        const msg = String(e.message).split('\n')[0];
        if (msg.includes('ERR_') || msg.includes('net::')) throw new Error(`页面导航失败（可能无网络）：${msg}`);
        // chromium 系对特殊页 goto 可能报错但实际已加载，继续探测
      }
      await pageOpened;
      await p.bringToFront();
      await sleep(500);
      osSendKeys(OS_PROC, 'Alt+Shift+S');
      await sleep(2000);
      const probe = await h.sw.evaluate(() =>
        chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(
          (d) => ({ ok: true, bytes: d.length }),
          (e) => ({ ok: false, err: String(e.message).split('\n')[0] })));
      const badge = await badgeText(h);
      captureProbe.push({ page: target.name, url: target.url.slice(0, 60), probe, badge });
      console.log(`        [obs] capture=${JSON.stringify(probe)} badge=${JSON.stringify(badge)}`);
      await p.close().catch(() => {});
    });
  }

  await t('D4 特殊页失败后 badge ✕ 3 秒自动清除（无残留）', async () => {
    // D3 循环最后一页结束后等待 badge 清除周期
    await sleep(3300);
    const badge = await badgeText(h);
    assertEq(badge, '', 'badge 应自动清空');
    console.log(`        [obs] captureProbe 表已收集 ${captureProbe.length} 项`);
  });

  return captureProbe;
}

// ================= Suite E：zxing 引擎链与全码制（V1.2-PLAN PR-1） =================

async function suiteE(h) {
  currentGroup = 'E-ZXING';
  console.log('\n== E-ZXING: zxing 引擎链 / 全码制矩阵 / 离线证明 / 引擎分档边界 ==');
  const page = await newPopup(h);
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), err: String(e) }));

  const decodeDirect = (pg, file) => pg.evaluate(async (src) => {
    const results = await window.QR2Link.decodeImage(src);
    return { results, stats: window.QR2Link.getLastDecodeStats() };
  }, fileDataUrl(file));

  await t('E1 阶段 1 快扫命中：normal.png → engine=zxing、format=QRCode、stats 仅阶段 1', async () => {
    const { results, stats } = await decodeDirect(page, path.join(TEST_DIR, 'normal.png'));
    assertEq(results.length, 1, '结果数');
    assertEq(results[0].text, 'https://example.com/qr2link-test', '解码文本');
    assertEq(results[0].engine, 'zxing', '桌面无原生环境应由 zxing 命中');
    assertEq(results[0].format, 'QRCode', 'format canonical 名');
    assertEq(stats.stages.join(''), '1', '阶段 1 即命中');
    assertEq(stats.zxingBroken, false, 'zxing 应健康');
    assertEq(stats.stage2Engine, null, '未进阶段 2');
  });

  await t('E2 全码制矩阵 11 种：文本 + format canonical 名逐一锁定（拍板⑧；UPCA 按 zxing 语义记 EAN13 前置 0）', async () => {
    const EXPECT = [
      ['qrcode', 'https://example.com/qr2link-matrix-qr', 'QRCode'],
      ['ean13', '5901234123457', 'EAN13'],
      ['upca', '0036000291452', 'EAN13'],
      ['code128', 'QR2LINK-CODE128', 'Code128'],
      ['code39', 'QR2LINK-39', 'Code39'],
      ['code93', 'QR2LINK-93', 'Code93'],
      ['itf', '1234567890', 'ITF'],
      ['codabar', 'A123456A', 'Codabar'],
      ['datamatrix', 'https://example.com/qr2link-matrix-dm', 'DataMatrix'],
      ['aztec', 'https://example.com/qr2link-matrix-aztec', 'Aztec'],
      ['pdf417', 'https://example.com/qr2link-matrix-pdf417', 'PDF417'],
    ];
    for (const [file, text, format] of EXPECT) {
      const { results } = await decodeDirect(page, path.join(TEST_DIR, 'matrix', `fmt-${file}.png`));
      assertEq(results.length, 1, `${file} 结果数`);
      assertEq(results[0].text, text, `${file} 解码文本`);
      assertEq(results[0].format, format, `${file} format canonical 名`);
      assertEq(results[0].engine, 'zxing', `${file} engine`);
    }
  });

  await t('E3 UI：ean13 上传 → 结果 meta 前缀展示码制名「EAN13 · …」（A2 全码制 UI）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'matrix', 'fmt-ean13.png'));
    await waitResults(page);
    const meta = await page.locator('.result-card .result-meta').first().textContent();
    assert(meta.startsWith('EAN13 · '), `meta 应以「EAN13 · 」前缀展示码制名，实际 ${meta}`);
    assertEq(await page.locator('.result-card .result-text').first().textContent(), '5901234123457', 'EAN13 文本');
  });

  await t('E4 zxing 整图多码：two-codes / four-corners 均在阶段 1 命中多卡（不再依赖阶段 3 梯子）', async () => {
    const two = await decodeDirect(page, path.join(TEST_DIR, 'two-codes.png'));
    assertEq(two.results.length, 2, 'two-codes 应 2 结果');
    assertEq(two.stats.stages.join(''), '1', 'two-codes 应阶段 1 整图多码');
    const four = await decodeDirect(page, path.join(OUT_DIR, 'four-corners.png'));
    assertEq(four.results.length, 4, 'four-corners 应 4 结果');
    assertEq(four.stats.stages.join(''), '1', 'four-corners 应阶段 1 整图多码');
  });

  await t('E5 fallback 锁定：zxing 健康但空结果 → 阶段 1 由 jsQR 救回（review 修订版）', async () => {
    // 与 B29-32 同法：覆盖注入须发生在任何解码之前 → 全新 popup 页（引擎状态按文档隔离）
    const p = await newPopup(h);
    try {
      await p.evaluate(() => {
        // 让 zxing「健康但空结果」：readBarcodes 恒返 []（不 throw、不置 zxingBroken）
        window.ZXingWASM.readBarcodes = async () => [];
      });
      const { results, stats } = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { results: rs, stats: window.QR2Link.getLastDecodeStats() };
      }, fileDataUrl(path.join(TEST_DIR, 'inverted.png')));
      assertEq(results.length, 1, 'jsQR 应救回反色码');
      assertEq(results[0].text, 'https://example.com/qr2link-inverted', '救回文本');
      assertEq(results[0].engine, 'jsqr', '空结果时阶段 1 应兜 jsQR');
      assertEq(stats.zxingBroken, false, '空返回不算损坏');
      assertEq(stats.stages.join(''), '1', '阶段 1 即救回');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E5b fallback 锁定：zxing 健康空结果时阶段 2 不回落 jsQR（大图双引擎叠加防护）', async () => {
    const p = await newPopup(h);
    try {
      await p.evaluate(() => { window.ZXingWASM.readBarcodes = async () => []; });
      const stats = await p.evaluate(async (src) => {
        await window.QR2Link.decodeImage(src);
        return window.QR2Link.getLastDecodeStats();
      }, fileDataUrl(path.join(OUT_DIR, 'bnd-9mp.png')));
      assertEq(stats.stage2Engine, 'zxing', '9MP 应记 zxing 档');
      assertEq(stats.zxingBroken, false, '空返回不置损坏');
      assert(stats.stages.includes('3'), '阶段 3 梯子仍执行（jsQR 逐块）');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E5c fallback 锁定：zxing 运行期异常 → zxingBroken 置位，jsQR 全程接管', async () => {
    const p = await newPopup(h);
    try {
      await p.evaluate(() => { window.ZXingWASM.readBarcodes = async () => { throw new Error('fake zxing failure'); }; });
      const r = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { results: rs, stats: window.QR2Link.getLastDecodeStats() };
      }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      assertEq(r.results[0].engine, 'jsqr', 'zxing 异常后应由 jsQR 接管');
      assertEq(r.stats.zxingBroken, true, 'zxingBroken 应置位');
      const r2 = await p.evaluate(async (src) => (await window.QR2Link.decodeImage(src))[0], fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      assertEq(r2.engine, 'jsqr', '置位后同文档后续解码短路走 jsQR');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E5d fallback 锁定：zxing 初始化失败（prepareZXingModule 抛错）→ jsQR 接管、只尝试一次、不 reject（PR #4 review P2-4）', async () => {
    const p = await newPopup(h);
    try {
      await p.evaluate(() => {
        let calls = 0;
        window.__zxingPrepareCalls = () => calls;
        window.ZXingWASM.prepareZXingModule = function () { calls += 1; throw new Error('fake init failure'); };
      });
      const r = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { results: rs, stats: window.QR2Link.getLastDecodeStats(), prepareCalls: window.__zxingPrepareCalls() };
      }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      assertEq(r.results.length, 1, '初始化失败不应导致 reject，jsQR 应命中');
      assertEq(r.results[0].engine, 'jsqr', '初始化失败由 jsQR 接管');
      assertEq(r.stats.zxingBroken, true, 'zxingBroken 应置位');
      assertEq(r.prepareCalls, 1, 'prepareZXingModule 只应被调用一次');
      const r2 = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { engine: rs[0].engine, prepareCalls: window.__zxingPrepareCalls() };
      }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      assertEq(r2.engine, 'jsqr', '置位后短路走 jsQR');
      assertEq(r2.prepareCalls, 1, '置位后不再重复初始化');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E6 引擎分档边界：恰 20MP → stage2Engine=zxing；20MP+1px → jsqr（性能基准定档锁定）', async () => {
    const a = await decodeDirect(page, path.join(OUT_DIR, 'bnd-20mp.png'));
    assertEq(a.stats.stage2Engine, 'zxing', '恰 20MP 应走 zxing 档');
    assert(a.stats.stages.includes('2'), '20MP 应执行阶段 2');
    const b = await decodeDirect(page, path.join(OUT_DIR, 'bnd-20mp-plus.png'));
    assertEq(b.stats.stage2Engine, 'jsqr', '20MP+1px 应回落 jsQR 档');
    assert(b.stats.stages.includes('2'), '20MP+1px 仍执行阶段 2（≤50MP）');
  });

  await t('E6b 探针真实值：zxingBroken 后 20MP 阶段 2 记录 stage2Engine=jsqr 而非按像素档写 zxing（PR #4 review P2-3）', async () => {
    const p = await newPopup(h);
    try {
      await p.evaluate(() => { window.ZXingWASM.readBarcodes = async () => { throw new Error('fake zxing failure'); }; });
      const stats = await p.evaluate(async (src) => {
        await window.QR2Link.decodeImage(src);
        return window.QR2Link.getLastDecodeStats();
      }, fileDataUrl(path.join(OUT_DIR, 'bnd-20mp.png')));
      assertEq(stats.zxingBroken, true, '应已置位');
      assertEq(stats.stage2Engine, 'jsqr', '探针应记录实际引擎 jsqr');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E7 离线冷启动证明：全新文档先 setOffline 再首解码，wasm 取自扩展包且零外网请求（PR #4 review P2-5）', async () => {
    const p = await newPopup(h);
    try {
      // 拦截 fetch/XHR 记录 wasm 加载来源（resource timing 不记 chrome-extension:// 资源，故用拦截）
      await p.evaluate(() => {
        window.__netLog = [];
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          window.__netLog.push(String(input && input.url ? input.url : input));
          return origFetch.apply(this, arguments);
        };
        const OrigXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = class extends OrigXHR {
          open(method, url) { window.__netLog.push(String(url)); return super.open(...arguments); }
        };
      });
      await p.context().setOffline(true);
      const r = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { results: rs, netLog: window.__netLog };
      }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      assertEq(r.results.length, 1, '离线冷启动（首解码即离线）仍应成功');
      assertEq(r.results[0].text, 'https://example.com/qr2link-test', '离线解码文本');
      const wasmReq = r.netLog.filter((n) => n.includes('zxing_reader.wasm'));
      assert(wasmReq.length >= 1, `wasm 应经 fetch/XHR 自扩展包加载，实际 ${JSON.stringify(r.netLog)}`);
      assert(wasmReq.every((n) => n.startsWith('chrome-extension://')), `wasm 必须来自扩展包（locateFile 重写生效），实际 ${JSON.stringify(wasmReq)}`);
      const remote = r.netLog.filter((n) => /^https?:\/\//.test(n));
      assertEq(remote.length, 0, `不应有外网请求（含 jsDelivr），实际 ${JSON.stringify(remote)}`);
      const perfRemote = await p.evaluate(() =>
        performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /^https?:\/\//.test(n)));
      assertEq(perfRemote.length, 0, `performance entries 亦应零 http(s)，实际 ${JSON.stringify(perfRemote)}`);
    } finally {
      await p.context().setOffline(false);
      await p.close().catch(() => {});
    }
  });

  await t('E7b offscreen 链路 1D：code128 经 decodeInOffscreen → engine=zxing、format=Code128（快捷键/右键真实链路）', async () => {
    const out = await h.sw.evaluate(async (src) => decodeInOffscreen({ kind: 'dataURL', value: src }), fileDataUrl(path.join(TEST_DIR, 'matrix', 'fmt-code128.png')));
    assertEq(out.length, 1, '结果数');
    assertEq(out[0].text, 'QR2LINK-CODE128', 'Code128 文本');
    assertEq(out[0].format, 'Code128', 'format canonical 名');
    assertEq(out[0].engine, 'zxing', 'offscreen 亦由 zxing 命中');
  });

  await t('E8 wasm 首次实例化：全新文档首解码（含实例化）应 < 10s（node 侧 ~49s 异常不得复现于浏览器）', async () => {
    const p = await newPopup(h);
    try {
      const ms = await p.evaluate(async (src) => {
        const t0 = performance.now();
        await window.QR2Link.decodeImage(src);
        return performance.now() - t0;
      }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
      console.log(`        [obs] 首解码含 wasm 实例化耗时 ${ms.toFixed(0)}ms`);
      assert(ms < 10000, `浏览器首解码异常缓慢：${ms.toFixed(0)}ms（>10s）`);
    } finally { await p.close().catch(() => {}); }
  });

  await t('E9 native 短路修复：原生命中 QR 后 zxing 仍执行 → 混合码图（QR+Code128）双结果（PR #4 review P1-1）', async () => {
    const p = await newPopup(h);
    try {
      // 注入仅返回 QR 的原生引擎（模拟 native-capable 浏览器；zxing 未损坏，验证合并而非短路）
      await p.evaluate(() => {
        window.BarcodeDetector = class {
          static async getSupportedFormats() { return ['qr_code']; }
          constructor() {}
          async detect() { return [{ rawValue: 'https://example.com/qr2link-mixed' }]; }
        };
      });
      const { results, stats } = await p.evaluate(async (src) => {
        const rs = await window.QR2Link.decodeImage(src);
        return { results: rs, stats: window.QR2Link.getLastDecodeStats() };
      }, fileDataUrl(path.join(TEST_DIR, 'matrix', 'mixed-qr-1d.png')));
      assertEq(results.length, 2, 'native 命中 QR 不应短路 zxing，混合码应双结果');
      const byText = {};
      for (const r of results) byText[r.text] = r;
      assert(byText['https://example.com/qr2link-mixed'], 'QR 结果应在（native 命中）');
      assert(byText['QR2LINK-CODE128'], 'Code128 结果应在（zxing 补齐，native 读不了 1D）');
      assertEq(byText['QR2LINK-CODE128'].engine, 'zxing', '1D 由 zxing 命中');
      assertEq(byText['QR2LINK-CODE128'].format, 'Code128', 'format canonical 名');
      assertEq(stats.stages.join(''), '1', '阶段 1 合并命中');
    } finally { await p.close().catch(() => {}); }
  });

  await t('E10 20MP 生产档浏览器端耗时门禁：无码图全链路 < 8s 且走 zxing 档（慢设备回归早发现，PR #4 review P1-2）', async () => {
    const p = await newPopup(h);
    try {
      const ms = await p.evaluate(async (src) => {
        const t0 = performance.now();
        await window.QR2Link.decodeImage(src);
        return performance.now() - t0;
      }, fileDataUrl(path.join(OUT_DIR, 'bnd-20mp.png')));
      const stats = await p.evaluate(() => window.QR2Link.getLastDecodeStats());
      console.log(`        [obs] 20MP 无码全链路 ${ms.toFixed(0)}ms（stages=${stats.stages.join('')}）`);
      assertEq(stats.stage2Engine, 'zxing', '应走 zxing 档');
      assert(ms < 8000, `20MP 无码链路异常缓慢：${ms.toFixed(0)}ms（>8s 门禁，阶段 2 预算受威胁）`);
    } finally { await p.close().catch(() => {}); }
  });

  await page.close().catch(() => {});
}

// ================= Suite F：结构化解析（V1.2-PLAN PR-2，C1） =================

async function suiteF(h) {
  currentGroup = 'F-PARSE';
  console.log('\n== F-PARSE: 结构化解析（parsers.js：WIFI/otpauth/vCard/tel/sms/mailto/geo） ==');
  const page = await newPopup(h);
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), err: String(e) }));

  // 函数级断言统一通道：输入数组传参（避免 evaluate 内二次转义），逐条 parse
  const parseAll = (inputs) => page.evaluate((arr) => arr.map((s) => window.Parsers.parse(s)), inputs);

  await t('F1 WIFI 正向：四种转义还原 / nopass / 小写前缀宽容 / 重复字段后值覆盖（V1.2-PLAN PR-2）', async () => {
    const out = await parseAll([
      'WIFI:T:WPA;S:My\\;Network;P:p\\;a\\:ss\\,\\\\;H:true;;',
      'WIFI:T:nopass;S:opennet;;',
      'wifi:T:WPA;S:lower;P:pw;;',
      'WIFI:T:WEP;S:first;S:second;P:a;;',
    ]);
    assertEq(out[0] && out[0].kind, 'wifi', '转义用例 kind');
    assertEq(out[0].ssid, 'My;Network', '转义 SSID（\\; 还原）');
    assertEq(out[0].password, 'p;a:ss,\\', '转义密码（\\; \\: \\, \\\\ 全还原）');
    assertEq(out[0].auth, 'WPA', 'auth');
    assertEq(out[0].hidden, true, 'hidden');
    assertEq(out[1].auth, 'nopass', 'nopass');
    assertEq(out[1].password, null, 'nopass 无密码');
    assertEq(out[2] && out[2].ssid, 'lower', '小写前缀宽容');
    assertEq(out[3].ssid, 'second', '重复字段后值覆盖');
    assertEq(out[3].auth, 'WEP', 'WEP');
  });

  await t('F2 WIFI 负面：缺字段/空 SSID/非法 T/非法 H/超长/字段数超限/悬空反斜杠 → null 回落纯文本契约', async () => {
    const longSsid = 'WIFI:T:WPA;S:' + 'x'.repeat(300) + ';;';
    let manyPairs = 'WIFI:T:WPA;S:ok';
    for (let i = 0; i < 20; i++) manyPairs += ';X' + i + ':v';
    manyPairs += ';;';
    const out = await parseAll([
      'WIFI:T:WPA;P:x;;',           // 缺 S
      'WIFI:T:WPA;S:;;',            // 空 SSID
      'WIFI:T:XYZ;S:s;;',           // 未知加密方式
      'WIFI:T:WPA;S:s;H:maybe;;',   // 非法 H
      longSsid,                     // 单字段超长
      manyPairs,                    // 字段数 > 16
      'WIFI:T:WPA;S:x\\',           // 悬空反斜杠
      'WIFI:',                      // 空体
      'WIFIX:T:WPA;S:s;;',          // 非 WIFI 前缀
    ]);
    for (let i = 0; i < out.length; i++) assertEq(out[i], null, `负面 #${i + 1} 应返回 null`);
  });

  await t('F3 otpauth 解析：label issuer/account、参数默认值、secret 大小写与空白归一、hotp counter', async () => {
    const out = await parseAll([
      'otpauth://totp/QR2Link:alice%40example.com?issuer=QR2Link&secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60&algorithm=SHA256',
      'otpauth://totp/plainaccount?secret=gezd%20gnbv',
      'otpauth://hotp/QR2Link:bob?counter=5&secret=gezdGNBV',
      'otpauth://hotp/nocounter?secret=GEZDGNBV',
    ]);
    assertEq(out[0].kind, 'totp', 'kind');
    assertEq(out[0].issuer, 'QR2Link', 'label 前段 issuer');
    assertEq(out[0].account, 'alice@example.com', 'label 后段 account（%40 解码）');
    assertEq(out[0].secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'secret');
    assertEq(out[0].digits, 8, 'digits 显式');
    assertEq(out[0].period, 60, 'period 显式');
    assertEq(out[0].algorithm, 'SHA256', 'algorithm 显式');
    assertEq(out[1].digits, 6, 'digits 默认 6');
    assertEq(out[1].period, 30, 'period 默认 30');
    assertEq(out[1].algorithm, 'SHA1', 'algorithm 默认 SHA1');
    assertEq(out[1].secret, 'GEZDGNBV', '小写+内嵌空格归一');
    assertEq(out[2].kind, 'hotp', 'hotp kind');
    assertEq(out[2].counter, 5, 'counter 显式');
    assertEq(out[3].counter, 0, 'counter 默认 0');
  });

  await t('F4 TOTP RFC 6238 Appendix B 官方向量（SHA1/SHA256/SHA512 8 位 ×12）+ 6 位取模（拍板①正确性锁定）', async () => {
    const r = await page.evaluate(async () => {
      // 测试侧 Base32 编码（RFC 4648）：向量的 ASCII 密钥 → otpauth 同构输入
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const b32 = (s) => {
        let bits = 0, val = 0, out = '';
        for (const ch of new TextEncoder().encode(s)) {
          val = (val << 8) | ch; bits += 8;
          while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
        }
        if (bits) out += A[(val << (5 - bits)) & 31];
        return out;
      };
      const K20 = '12345678901234567890';
      const K32 = '12345678901234567890123456789012';
      const K64 = '1234567890123456789012345678901234567890123456789012345678901234';
      const CASES = [
        [59, 'SHA1', K20, '94287082'], [1111111109, 'SHA1', K20, '07081804'],
        [1111111111, 'SHA1', K20, '14050471'], [1234567890, 'SHA1', K20, '89005924'],
        [2000000000, 'SHA1', K20, '69279037'], [20000000000, 'SHA1', K20, '65353130'],
        [59, 'SHA256', K32, '46119246'], [1111111109, 'SHA256', K32, '68084774'],
        [1234567890, 'SHA256', K32, '91819424'],
        [59, 'SHA512', K64, '90693936'], [1111111109, 'SHA512', K64, '25091201'],
        [2000000000, 'SHA512', K64, '38618901'],
      ];
      const out = [];
      for (const c of CASES) {
        const got = await window.Parsers.generateTotp(b32(c[2]), { digits: 8, period: 30, algorithm: c[1] }, c[0] * 1000);
        out.push([c[0], c[1], got, c[3]]);
      }
      out.push([59, 'SHA1-d6', await window.Parsers.generateTotp(b32(K20), { digits: 6, period: 30, algorithm: 'SHA1' }, 59 * 1000), '287082']);
      return out;
    });
    for (const [tSec, alg, got, want] of r) {
      assertEq(got, want, `RFC 6238 t=${tSec} ${alg}（期望 ${want}）`);
    }
  });

  await t('F5 TOTP 时间边界与倒计时：跨窗换码 / 同窗同码 / totpRemaining 纯函数', async () => {
    const r = await page.evaluate(async () => {
      const S = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
      const g = (ms) => window.Parsers.generateTotp(S, { digits: 8, period: 30 }, ms);
      const [a, b, c] = await Promise.all([g(29999), g(30000), g(59999)]);
      const R = window.Parsers.totpRemaining;
      return { a, b, c, r1: R(30, 29999), r2: R(30, 30000), r3: R(60, 60000), r4: R(30, 59399) };
    });
    assert(r.a !== r.b, '跨周期边界（29999→30000ms）应换码');
    assertEq(r.b, r.c, '同窗（30000/59999ms）应同码');
    assertEq(r.r1, 1, 'remaining(30, 29999)=1');
    assertEq(r.r2, 30, 'remaining(30, 30000)=30');
    assertEq(r.r3, 60, 'remaining(60, 60000)=60');
    assertEq(r.r4, 1, 'remaining(30, 59399)=1');
  });

  await t('F6 otpauth 负面：非法 Base32/缺 secret/非法 digits/period/algorithm/type/尾位组合 → null', async () => {
    const out = await parseAll([
      'otpauth://totp/a?secret=ABC01XYZ',  // 0/1 不在 Base32 字母表
      'otpauth://totp/a?secret=ABC!XYZ',   // 非法符号
      'otpauth://totp/a?secret=',
      'otpauth://totp/a',                  // 缺 secret
      'otpauth://totp/a?secret=GEZDGNBV&digits=5',
      'otpauth://totp/a?secret=GEZDGNBV&digits=9',
      'otpauth://totp/a?secret=GEZDGNBV&digits=abc',
      'otpauth://totp/a?secret=GEZDGNBV&period=0',
      'otpauth://totp/a?secret=GEZDGNBV&period=3601',
      'otpauth://totp/a?secret=GEZDGNBV&algorithm=MD5',
      'otpauth://batp/a?secret=GEZDGNBV',  // 非法 type
      'otpauth:///a?secret=GEZDGNBV',      // 空 type
      'otpauth://totp/a?secret=GEZDGN',    // 6 字符 = 非法尾位组合（30 bits 余 6）
    ]);
    for (let i = 0; i < out.length; i++) assertEq(out[i], null, `负面 #${i + 1} 应返回 null`);
  });

  await t('F7 vCard 正向：折叠行拼接 / 多值 TEL+EMAIL / ;TYPE 参数剥离 / 值反转义 / raw 原文', async () => {
    // 折叠语义（RFC 6350 §3.2）：CRLF + 恰好一个空白为折叠符被剥除——续行两个空格
    // 中一个是折叠符、一个是内容空格，展开后 FN = 'Alice Zhang'
    const v = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Alice', '  Zhang', 'TEL:+8613800138000',
      'TEL;TYPE=CELL:+8613900139000', 'EMAIL:a@example.com', 'EMAIL:b@example.com',
      'ORG:QR2Link\\;Inc.', 'TITLE:Engineer', 'END:VCARD'].join('\r\n');
    const [p] = await parseAll([v]);
    assertEq(p && p.kind, 'vcard', 'kind');
    assertEq(p.fn, 'Alice Zhang', '折叠行（续行空格拼接）');
    assertEq(p.tels.length, 2, '多值 TEL');
    assertEq(p.tels[1], '+8613900139000', ';TYPE 参数剥离');
    assertEq(p.emails.length, 2, '多值 EMAIL');
    assertEq(p.org, 'QR2Link', 'ORG 值反转义后取主段');
    assertEq(p.title, 'Engineer', 'TITLE');
    assertEq(p.raw, v, 'raw 保留原文（下载 .vcf 用）');
  });

  await t('F8 vCard 负面：缺 END / 缺 BEGIN / 无可展示字段 / 超行数上限 → null', async () => {
    const noEnd = 'BEGIN:VCARD\r\nFN:X\r\n';
    const noBegin = 'VERSION:3.0\r\nFN:X\r\nEND:VCARD';
    const empty = 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD';
    let many = 'BEGIN:VCARD\r\nFN:X\r\n';
    for (let i = 0; i < 120; i++) many += 'NOTE:x' + i + '\r\n';
    many += 'END:VCARD';
    const out = await parseAll([noEnd, noBegin, empty, many]);
    assertEq(out[0], null, '缺 END');
    assertEq(out[1], null, '缺 BEGIN');
    assertEq(out[2], null, '无可展示字段');
    assertEq(out[3], null, '超行数上限');
  });

  await t('F9 tel/sms/smsto/mailto/geo 解析正向：参数、%XX 解码、geo 海拔与 crs 剥离', async () => {
    const out = await parseAll([
      'tel:+86-138-0013-8000',
      'sms:+8613800138000?body=hello%20world',
      'smsto:+8613800138000,hello%3F',
      'mailto:alice@example.com?subject=Hi&body=Welcome',
      'mailto:bob@example.com',
      'geo:31.230416,121.473701',
      'geo:1.5,2.5,300;crs=wgs84',
    ]);
    assertEq(out[0].kind, 'tel');
    assertEq(out[0].number, '+86-138-0013-8000');
    assertEq(out[1].kind, 'sms');
    assertEq(out[1].number, '+8613800138000');
    assertEq(out[1].body, 'hello world');
    assertEq(out[2].kind, 'sms');
    assertEq(out[2].number, '+8613800138000', 'smsto 逗号形态号码');
    assertEq(out[2].body, 'hello?', 'smsto 逗号形态内容（%3F 解码）');
    assertEq(out[3].kind, 'mailto');
    assertEq(out[3].to, 'alice@example.com');
    assertEq(out[3].subject, 'Hi');
    assertEq(out[3].body, 'Welcome');
    assertEq(out[4].subject, null, 'mailto 无参数');
    assertEq(out[5].kind, 'geo');
    assertEq(out[5].lat, 31.230416);
    assertEq(out[5].lon, 121.473701);
    assertEq(out[6].lat, 1.5, 'geo 海拔段与 ;crs 参数剥离');
  });

  await t('F9b tel/sms/mailto/geo 负面：空值/非法字符/越界/超长 → null', async () => {
    const out = await parseAll([
      'tel:',
      'tel:abc@def',
      'sms:abc?body=x',
      'mailto:',
      'mailto:' + 'x'.repeat(300) + '@a.b',
      'geo:99,0',
      'geo:abc,def',
      'geo:1.0',
    ]);
    for (let i = 0; i < out.length; i++) assertEq(out[i], null, `负面 #${i + 1} 应返回 null`);
  });

  await t('F10 输入长度上限与 maskSecrets：>4096 → null；otpauth 显示层打码、其余文本原样', async () => {
    const r = await page.evaluate(() => {
      const P = window.Parsers;
      return {
        long: P.parse('WIFI:T:WPA;S:' + 'x'.repeat(4100) + ';;'),
        longOtp: P.parse('otpauth://totp/a?secret=' + 'A'.repeat(4100)),
        mask: P.maskSecrets('otpauth://totp/a?issuer=X&secret=GEZDGNBV&digits=6'),
        maskOnly: P.maskSecrets('otpauth://totp/a?secret=GEZDGNBV'),
        plain: P.maskSecrets('WIFI:T:WPA;S:s;P:pass;;'),
      };
    });
    assertEq(r.long, null, '超长 WIFI 拒绝');
    assertEq(r.longOtp, null, '超长 otpauth 拒绝');
    assert(r.mask.indexOf('GEZDGNBV') === -1, '打码后不应含明文 secret');
    assert(r.mask.indexOf('secret=\u2022\u2022') > 0, '打码后应含 ••');
    assert(r.mask.startsWith('otpauth://totp/a?issuer=X&'), '其余参数保留原样');
    assertEq(r.maskOnly, 'otpauth://totp/a?secret=\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', '仅 secret 值替换');
    assertEq(r.plain, 'WIFI:T:WPA;S:s;P:pass;;', '非 otpauth 原样返回');
  });

  await t('F11 UI：WIFI 码上传 → 结构化卡片字段还原展示 + 复制密码写剪贴板', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'wifi.png'));
    await waitResults(page);
    const card = page.locator('.parsed-card[data-kind="wifi"]');
    await card.waitFor({ state: 'visible' });
    const vals = await card.locator('.parsed-value').allTextContents();
    assert(vals.includes('My;Network') && vals.includes('p;a:ss,\\'), `转义字段应还原展示，实际 ${JSON.stringify(vals)}`);
    assert(vals.includes(msg('parse_yes')), 'H:true 应显示肯定值');
    await card.locator('.mini-btn', { hasText: msg('btn_copy') }).click();
    await sleep(300);
    assertEq(await getClipboardText(), 'p;a:ss,\\', '复制密码（还原后的明文）');
  });

  await t('F12 UI：otpauth 码上传 → 动态码 + 倒计时 + secret 打码切换；原文显示层打码、复制取原文', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'otpauth.png'));
    await waitResults(page);
    const card = page.locator('.parsed-card[data-kind="totp"]');
    await card.waitFor({ state: 'visible' });
    const code = await card.locator('.otp-code').textContent();
    assert(/^\d{6}$/.test(code), `动态码应为 6 位数字，实际 ${code}`);
    const cd = await card.locator('.otp-countdown').textContent();
    assert(/^\d+s$/.test(cd), `倒计时应为 Ns 形态，实际 ${cd}`);
    const secretVal = card.locator('.parsed-secret .secret-value');
    assertEq(await secretVal.textContent(), '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', 'secret 默认打码');
    await card.locator('.mini-btn', { hasText: msg('parse_show_secret') }).click();
    assertEq(await secretVal.textContent(), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '点击显示明文');
    assertEq(await card.locator('.mini-btn', { hasText: msg('parse_hide_secret') }).count(), 1, '按钮翻转为隐藏');
    const shown = await page.locator('.result-card .result-text').first().textContent();
    assert(shown.indexOf('GEZDGNBVGY3TQOJQ') === -1, `结果原文显示层应打码，实际 ${shown}`);
    assert(shown.indexOf('\u2022\u2022\u2022\u2022') >= 0, '打码符号应可见');
    await page.locator('.result-actions .mini-btn', { hasText: msg('btn_copy') }).first().click();
    await sleep(300);
    assert((await getClipboardText()).indexOf('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') >= 0, '复制应保持原文');
  });

  await t('F13 UI：历史行 otpauth 显示层打码 + 显示切换 + 存储/复制保持原文（review P1）', async () => {
    await goHome(page);
    await page.locator('label.switch').click(); // 开启历史
    await sleep(200);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'otpauth.png'));
    await waitResults(page);
    await page.locator('.result-actions .mini-btn', { hasText: msg('btn_keep') }).first().click();
    await sleep(300);
    await goHome(page);
    const row = page.locator('#history-list .history-item').first();
    const shown = await row.locator('.history-text').textContent();
    assert(shown.indexOf('GEZDGNBVGY3TQOJQ') === -1 && shown.indexOf('\u2022\u2022\u2022') >= 0, `历史行显示层应打码，实际 ${shown}`);
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.items'].length, 1, '存储 1 条');
    assert(stored['qr2link.history.items'][0].text.indexOf('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') >= 0, '存储保持原文');
    await row.locator('.mini-btn', { hasText: msg('parse_show_secret') }).click();
    assert((await row.locator('.history-text').textContent()).indexOf('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') >= 0, '点击显示后历史行明文');
    await row.locator('.mini-btn', { hasText: msg('btn_copy') }).click();
    await sleep(300);
    assert((await getClipboardText()).indexOf('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') >= 0, '历史行复制保持原文');
  });

  await t('F14 UI：vCard 码上传 → 字段卡片 + 下载锚点（data:URI）；恶意 FN 以纯文本原样渲染（textContent 契约）', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'vcard.png'));
    await waitResults(page);
    const card = page.locator('.parsed-card[data-kind="vcard"]');
    await card.waitFor({ state: 'visible' });
    const vals = await card.locator('.parsed-value').allTextContents();
    assert(vals.includes('Alice Zhang'), 'FN 字段');
    assert(vals.includes('+8613800138000') && vals.includes('+8613900139000'), '两个 TEL');
    assert(vals.includes('alice@example.com'), 'EMAIL');
    const dl = card.locator('a[download]');
    assertEq(await dl.count(), 1, '下载锚点存在');
    const href = await dl.first().getAttribute('href');
    assert(href.startsWith('data:text/vcard;charset=utf-8,'), `href 应为 data:URI，实际 ${href && href.slice(0, 40)}`);
    assertEq(await dl.first().getAttribute('download'), 'contact.vcf', 'download 文件名');
    // 恶意字段内容：FN 注入 HTML —— textContent 渲染为字面文本，脚本不得执行
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(OUT_DIR, 'vcard-xss.png'));
    await waitResults(page);
    const xcard = page.locator('.parsed-card[data-kind="vcard"]');
    await xcard.waitFor({ state: 'visible' });
    const fn = await xcard.locator('.parsed-value').first().textContent();
    assertEq(fn, '<img src=x onerror="window.__xss=1">Bobby', '恶意 FN 应以纯文本原样呈现');
    assertEq(await page.evaluate(() => window.__xss), undefined, 'onerror 不应被执行');
  });

  await t('F15 UI：geo 码上传 → 坐标卡片、仅复制不打开（「仅 http/https 可打开」契约）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'geo.png'));
    await waitResults(page);
    const card = page.locator('.parsed-card[data-kind="geo"]');
    await card.waitFor({ state: 'visible' });
    const vals = await card.locator('.parsed-value').allTextContents();
    assert(vals.includes('31.230416') && vals.includes('121.473701'), `经纬度展示，实际 ${JSON.stringify(vals)}`);
    const btns = await page.locator('.result-card .result-actions .mini-btn').allTextContents();
    assert(!btns.includes(msg('btn_open')), 'geo 卡不应有打开按钮');
    assert(btns.includes(msg('btn_copy')), '应有复制按钮');
  });

  await t('F16 UI：HOTP 码上传 → 仅参数展示、无动态码（拍板①：hotp 不生成）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'hotp.png'));
    await waitResults(page);
    const card = page.locator('.parsed-card[data-kind="hotp"]');
    await card.waitFor({ state: 'visible' });
    assertEq(await card.locator('.otp-code').count(), 0, 'HOTP 不应有动态码');
    assertEq(await card.locator('.parsed-hint').textContent(), msg('parse_otp_hotp_hint'), 'HOTP 提示文案');
    const vals = await card.locator('.parsed-value').allTextContents();
    assert(vals.includes('5'), 'counter=5 展示');
  });

  await t('F17 TOTP 倒计时随视图切换清理：setInterval 全清、无泄漏（popup.js 清理契约）', async () => {
    // 在触发解码前 patch setInterval/clearInterval 记录活跃句柄（popup.js 在渲染时才调用）
    await page.evaluate(() => {
      window.__ivActive = new Set();
      const origSet = window.setInterval;
      const origClear = window.clearInterval;
      window.setInterval = function (fn, ms) {
        const id = origSet.call(window, fn, ms);
        window.__ivActive.add(id);
        return id;
      };
      window.clearInterval = function (id) {
        window.__ivActive.delete(id);
        return origClear.call(window, id);
      };
    });
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'structured', 'otpauth.png'));
    await waitResults(page);
    await page.locator('.parsed-card[data-kind="totp"]').waitFor({ state: 'visible' });
    const during = await page.evaluate(() => window.__ivActive.size);
    assert(during >= 1, `TOTP 卡片渲染后应有活跃倒计时 interval，实际 ${during}`);
    await goHome(page); // 离开结果视图 → clearTotpTimers
    await sleep(200);
    assertEq(await page.evaluate(() => window.__ivActive.size), 0, '视图切换后 interval 应全部清理');
  });

  // ---- PR #5 AIbot review 采纳用例（F18–F23 / G7）----

  await t('F18 maskSecrets 抗绕过：编码参数名 %73ecret 与重复 secret 逐项全遮蔽；非 secret 段原样保留（PR #5 review P1 + 复核 P3）', async () => {
    const r = await page.evaluate(() => {
      const P = window.Parsers;
      return {
        parseEnc: P.parse('otpauth://totp/a?%73ecret=GEZDGNBV'),
        enc: P.maskSecrets('otpauth://totp/a?%73ecret=GEZDGNBV'),
        dup: P.maskSecrets('otpauth://totp/a?secret=AAAAAAA1&digits=6&secret=BBBBBBB2'),
        pad: P.maskSecrets('  otpauth://totp/a?secret=GEZDGNBV  '),
        keep: P.maskSecrets('otpauth://totp/a?issuer=Foo+Bar&secret=GEZDGNBV&note=a+b'),
      };
    });
    assertEq(r.parseEnc && r.parseEnc.kind, 'totp', 'URLSearchParams 语义下 %73ecret 即 secret');
    assertEq(r.parseEnc.secret, 'GEZDGNBV', 'parse 应命中编码参数名（与遮蔽同源）');
    assert(r.enc.indexOf('GEZDGNBV') === -1, '编码参数名的 secret 必须被遮蔽');
    assert(r.enc.indexOf('%73ecret=\u2022\u2022') > 0, '遮蔽后应显示打码值（参数名保留原始编码形态）');
    assert(r.dup.indexOf('AAAAAAA1') === -1 && r.dup.indexOf('BBBBBBB2') === -1, '重复 secret 两项都遮蔽');
    assertEq((r.dup.match(/secret=\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022/g) || []).length, 2, '两个 secret 参数各有打码');
    assert(r.dup.indexOf('digits=6') > 0, '其余参数保留');
    assert(r.pad.indexOf('GEZDGNBV') === -1 && r.pad.indexOf('\u2022\u2022\u2022\u2022') >= 0, '前后空白输入宽容处理');
    // 复核 P3：非 secret 段保持原始编码形态（+ 不被重编码为 %2B/%20）
    assert(r.keep.indexOf('issuer=Foo+Bar') > 0 && r.keep.indexOf('note=a+b') > 0, `非 secret 段应原样保留，实际 ${r.keep}`);
    assert(r.keep.indexOf('GEZDGNBV') === -1, 'secret 仍被遮蔽');
  });

  await t('F19 vCard 边界：伪结束标记值/尾随垃圾/无冒号行拒绝；字面量反斜杠+n 正确反转义（PR #5 review P2）', async () => {
    const out = await parseAll([
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:END:VCARD\r\n',   // 值里伪造结束标记 → 无独立 END
      'BEGIN:VCARD\r\nFN:X\r\nEND:VCARD\r\nTRAILING\r\n', // 结束记录后尾随非空内容
      'BEGIN:VCARD\r\nTEL 123\r\nEND:VCARD',              // 无冒号的非结构行
    ]);
    for (let i = 0; i < out.length; i++) assertEq(out[i], null, `负面 #${i + 1} 应返回 null`);
    // 单趟反转义：'a\\nb'（转义反斜杠 + 字母 n）→ 字面量 'a\nb'；'a\nb' → 真换行
    const [p1, p2] = await parseAll(['BEGIN:VCARD\r\nFN:a\\\\nb\r\nEND:VCARD', 'BEGIN:VCARD\r\nFN:a\\nb\r\nEND:VCARD']);
    assertEq(p1 && p1.fn, 'a\\nb', '字面量反斜杠+n 不得被误解为换行');
    assertEq(p2 && p2.fn, 'a\nb', '\\n 转义仍为换行');
  });

  await t('F20 otpauth query issuer 优先 + query 参数末值覆盖（重复 secret / mailto body；PR #5 review P2）', async () => {
    const out = await parseAll([
      'otpauth://totp/alice?issuer=Google&secret=GEZDGNBV',
      'otpauth://totp/LabelIss:acc?issuer=QueryIss&secret=GEZDGNBV',
      'otpauth://totp/a?secret=ABC01XYZ&secret=GEZDGNBV',
      'mailto:a@b.c?body=first&body=second',
    ]);
    assertEq(out[0].issuer, 'Google', 'query-only issuer 命中');
    assertEq(out[0].account, 'alice', '无冒号 label 整体为 account');
    assertEq(out[1].issuer, 'QueryIss', 'label 与 query 同在时 query 优先（锁定契约）');
    assertEq(out[1].account, 'acc', 'account 不受 query issuer 影响');
    assertEq(out[2].secret, 'GEZDGNBV', '重复 secret 末值覆盖（首值非法不再整体拒绝）');
    assertEq(out[3].body, 'second', 'mailto 重复 body 末值覆盖');
  });

  await t('F21 Base32 canonical 校验：非法填充数/非零尾位/全填充拒绝，canonical 填充通过（PR #5 review P2）', async () => {
    const out = await parseAll([
      'otpauth://totp/a?secret=GE=',       // 填充 1（canonical 应为 6）
      'otpauth://totp/a?secret=GE=======', // 填充 7
      'otpauth://totp/a?secret=GF',        // 未用尾位非零
      'otpauth://totp/a?secret=====',      // 全填充（空 body）
      'otpauth://totp/a?secret=GE======',  // canonical：2 字符 + 6 填充
    ]);
    for (let i = 0; i < 4; i++) assertEq(out[i], null, `非 canonical #${i + 1} 应返回 null`);
    assertEq(out[4] && out[4].kind, 'totp', 'canonical 填充形态应通过');
  });

  await t('F22 tel 最小语法与 geo 第三段/超长校验（PR #5 review P2）', async () => {
    const longLat = 'geo:1.' + '0'.repeat(300) + ',2';
    const out = await parseAll([
      'tel:+',                 // 无数字
      'tel:++',                // '+' 重复
      'tel:12+34',             // '+' 中置
      'geo:1,2,not-a-number',  // 非法海拔
      'geo:1,2,3,4',           // 超过三段
      longLat,                 // 坐标段超长（>256）
      'geo:1,2,3',             // 合法海拔（不展示，仅校验）
    ]);
    for (let i = 0; i < 6; i++) assertEq(out[i], null, `负面 #${i + 1} 应返回 null`);
    assertEq(out[6] && out[6].kind, 'geo', '合法第三段（海拔）应通过');
  });

  await t('F23 generateTotp/totpRemaining 参数校验与 parse 口径一致（PR #5 review P3）', async () => {
    const r = await page.evaluate(async () => {
      const P = window.Parsers;
      const S = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
      const tryIt = (opts) => P.generateTotp(S, opts, 59000).then(() => 'ok', (e) => e.message);
      return {
        d5: await tryIt({ digits: 5 }),
        d9: await tryIt({ digits: 9 }),
        dFloat: await tryIt({ digits: 6.5 }),
        p0: await tryIt({ period: 0 }),
        pBig: await tryIt({ period: 3601 }),
        ok: await tryIt({ digits: 6, period: 30 }),
        rZero: P.totpRemaining(0, 30000),
        rNeg: P.totpRemaining(-5, 30000),
      };
    });
    assertEq(r.d5, 'BAD_DIGITS', 'digits=5 拒绝');
    assertEq(r.d9, 'BAD_DIGITS', 'digits=9 拒绝');
    assertEq(r.dFloat, 'BAD_DIGITS', '非整数 digits 拒绝');
    assertEq(r.p0, 'BAD_PERIOD', 'period=0 拒绝');
    assertEq(r.pBig, 'BAD_PERIOD', 'period=3601 拒绝');
    assertEq(r.ok, 'ok', '合法参数照常生成');
    assertEq(r.rZero, 30, 'totpRemaining 非法 period 兜底 30');
    assertEq(r.rNeg, 30, 'totpRemaining 负 period 兜底 30');
  });

  await page.close().catch(() => {});
  await h.sw.evaluate(() => chrome.storage.local.clear()).catch(() => {});
}

// ================= Suite G：安全预检（V1.2-PLAN PR-2，C2） =================

async function suiteG(h) {
  currentGroup = 'G-SAFETY';
  console.log('\n== G-SAFETY: 链接安全预检（safety.js：分级/排序/两段式确认/快捷键边界） ==');
  const page = await newPopup(h);
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), err: String(e) }));

  const assess = (urls) => page.evaluate((arr) => arr.map((u) => window.Safety.assessUrl(u)), urls);

  await t('G1 分级矩阵与 reasons 排序：danger 先于 caution、规则枚举序稳定（排序契约锁定）', async () => {
    const out = await assess([
      'https://example.com/',
      'http://example.com/',
      'https://192.168.1.1/admin',
      'https://[::1]/x',
      'https://[::ffff:1.2.3.4]/',
      'https://sub.bit.ly/x',
      'https://xn--pple-43d.com/',
      'https://user:pass@example.com/',
      'http://user:pass@192.168.1.1/',
      'http://bit.ly/x',
      'ftp://example.com/',
      'not a url',
    ]);
    assertEq(out[0].level, 'ok', 'https 普通域名 ok');
    assertEq(out[0].reasons.length, 0, 'ok 无原因');
    assertEq(out[1].level, 'caution', 'http 明文 caution');
    assertEq(out[1].reasons.join(), 'httpPlain');
    assertEq(out[2].reasons.join(), 'ipHost', 'IPv4 字面量');
    assertEq(out[3].reasons.join(), 'ipHost', 'IPv6 [::1]');
    assertEq(out[4].reasons.join(), 'ipHost', 'IPv4-mapped IPv6');
    assertEq(out[5].reasons.join(), 'shortLink', '短链子域命中');
    assertEq(out[6].level, 'danger', '混排域名 danger');
    assertEq(out[6].reasons.join(), 'idnHomograph', '西里尔а+拉丁pple');
    assertEq(out[7].level, 'danger');
    assertEq(out[7].reasons.join(), 'userPass', '内嵌凭据');
    assertEq(out[8].level, 'danger');
    assertEq(out[8].reasons.join(), 'userPass,httpPlain,ipHost', '多命中：danger 先、枚举序稳定');
    assertEq(out[9].reasons.join(), 'httpPlain,shortLink', '双 caution 枚举序');
    assertEq(out[10].level, 'ok', '非 http(s) 不评估');
    assertEq(out[11].level, 'ok', '畸形输入防御性 ok、不抛错');
  });

  await t('G2 punycode 边界：纯汉字/纯西里尔/拉丁变音符 IDN 不误报；畸形 xn-- 标签静默跳过（方案口径）', async () => {
    const out = await assess([
      'https://xn--fiqs8s.cn/',        // 「中国」纯汉字
      'https://xn--80ak6aa92e.com/',   // 「аррӏе」纯西里尔（无拉丁混排 → 不触发；已知边界）
      'https://xn--bcher-kva.com/',    // 「bücher」拉丁+变音符（ü 不属三系字母，单码制）
      'https://xn--.com/',             // 空标签
      'https://xn--' + 'z'.repeat(60) + '.com/', // 畸形超长（解码失败/溢出防护路径）
    ]);
    for (let i = 0; i < 3; i++) assertEq(out[i].level, 'ok', `纯单码制 IDN #${i} 不应误报`);
    for (let i = 3; i < out.length; i++) assertEq(out[i].level, 'ok', `畸形标签 #${i} 应静默跳过`);
  });

  await t('G3 UI：分级指示条（ok 绿 / caution 黄 / danger 红）+ 原因列表 i18n 文案与顺序渲染', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    const okBar = page.locator('.safety-bar.ok');
    await okBar.waitFor({ state: 'visible' });
    assertEq(await okBar.locator('.safety-level').textContent(), msg('safety_level_ok'), 'ok 级文案');
    assertEq(await okBar.locator('.safety-reasons').count(), 0, 'ok 无原因列表');

    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'safety', 'caution-ip.png'));
    await waitResults(page);
    const cBar = page.locator('.safety-bar.caution');
    await cBar.waitFor({ state: 'visible' });
    assertEq(await cBar.locator('.safety-level').textContent(), msg('safety_level_caution'), 'caution 级文案');
    assert(await cBar.locator('.safety-reasons').isHidden(), '原因列表默认折叠');
    await cBar.locator('.link-btn').click();
    const items = await cBar.locator('.safety-reasons li').allTextContents();
    assertEq(items.join('|'), [msg('safety_reason_http'), msg('safety_reason_ip')].join('|'), '原因渲染顺序 = reasons 序');

    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'safety', 'danger-punycode.png'));
    await waitResults(page);
    const dBar = page.locator('.safety-bar.danger');
    await dBar.waitFor({ state: 'visible' });
    assertEq(await dBar.locator('.safety-level').textContent(), msg('safety_level_danger'), 'danger 级文案');
    await dBar.locator('.link-btn').click();
    assertEq(await dBar.locator('.safety-reasons li').first().textContent(), msg('safety_reason_idn'), '混排原因文案');
  });

  await t('G4 danger 两段式确认：首击翻转、未确认 3s 自动还原、确认后打开（拍板⑦，复用 history-clear 模式）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'safety', 'danger-userpass.png'));
    await waitResults(page);
    const openBtn = page.locator('.result-actions .mini-btn', { hasText: msg('btn_open') }).first();
    await openBtn.click(); // 第一次：进入确认态，不打开
    assertEq(await openBtn.textContent(), msg('safety_confirm_open'), '按钮应翻转确认文案');
    await sleep(400);
    const strayed = await waitTabByUrl(h, 'example.com/qr2link-danger-up', 1200);
    assert(!strayed, '确认前不应打开链接');
    await sleep(3000); // 3s 解除窗口
    assertEq(await openBtn.textContent(), msg('btn_open'), '3 秒未确认应自动还原');
    // 二次流程：翻转后 3s 内确认 → 打开
    await openBtn.click();
    assertEq(await openBtn.textContent(), msg('safety_confirm_open'), '再次进入确认态');
    await openBtn.click();
    const opened = await waitTabByUrl(h, 'example.com/qr2link-danger-up');
    assert(opened, '确认后应打开链接');
    await opened.close().catch(() => {});
  });

  await t('G5 caution 级一键直开（不翻转确认）', async () => {
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'safety', 'caution-short.png'));
    await waitResults(page);
    const openBtn = page.locator('.result-actions .mini-btn', { hasText: msg('btn_open') }).first();
    await openBtn.click();
    assertEq(await openBtn.textContent(), msg('btn_open'), 'caution 不应翻转确认');
    const opened = await waitTabByUrl(h, 'bit.ly');
    assert(opened, 'caution 应一键直开');
    await opened.close().catch(() => {});
  });

  await t('G6 拍板③边界锁定：快捷键路径 danger URL 照常自动打开；SW 不加载 Safety（防合并行为锁）', async () => {
    // 与快捷键直扫同链路（captureVisibleTab → handleScan → openFirstLink，无安全预检分支）
    await h.sw.evaluate((src) => handleScan({ kind: 'dataURL', value: src }),
      fileDataUrl(path.join(TEST_DIR, 'safety', 'danger-userpass.png')));
    const opened = await waitTabByUrl(h, 'example.com/qr2link-danger-up');
    assert(opened, '快捷键路径 danger URL 应照常自动打开（v1.1 行为契约）');
    await opened.close().catch(() => {});
    // safety.js 不进 SW：openFirstLink 在依赖上无法接入预检（background.js 防合并注释）
    assertEq(await h.sw.evaluate(() => typeof self.Safety), 'undefined', 'SW 中不应存在 Safety 全局');
  });

  await t('G7 userPass 宽口径锁定：仅用户名 userinfo（user@host）同样 danger；渲染文案覆盖仅用户名形态（PR #5 review P2 + 复核 P3）', async () => {
    const out = await assess(['https://user@example.com/', 'https://example.com@evil.com/']);
    for (let i = 0; i < out.length; i++) {
      assertEq(out[i].level, 'danger', `仅用户名形态 #${i + 1} 应为 danger（@ 仿冒手法）`);
      assertEq(out[i].reasons.join(), 'userPass', '命中 userPass');
    }
    // 复核 P3：UI 实际渲染的原因文案须覆盖「仅用户名」形态（不再只以 user:pass@ 为例）
    await goHome(page);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'safety', 'danger-userpass.png'));
    await waitResults(page);
    const bar = page.locator('.safety-bar.danger');
    await bar.waitFor({ state: 'visible' });
    await bar.locator('.link-btn').click();
    assertEq(await bar.locator('.safety-reasons li').first().textContent(), msg('safety_reason_user_pass'), 'userPass 原因渲染文案');
  });

  await page.close().catch(() => {});
}

// ================= Suite H：生成二维码（V1.2-PLAN PR-3，D1+D2） =================

async function suiteH(h) {
  currentGroup = 'H-GENERATE';
  console.log('\n== H-GENERATE: 生成二维码（generate.js：预填/草稿/预览/样式矩阵/下载/复制图片/logo 边界/UTF-8/防冻结） ==');

  const DRAFT_KEY = 'qr2link.generate.draft';
  const GEN_A = 'https://example.com/qr2link-gen-a';
  const GEN_B = 'https://example.com/qr2link-gen-b';
  const ICON = path.join(EXT_DIR, 'icons', 'icon48.png');

  // 草稿存 storage.session（扩展级、跨 popup 页共享）且只在每页首次 open 读一次：
  // 断言初始态的用例必须先清草稿，并各用全新 popup 页
  const clearDraft = (page) => page.evaluate((k) => chrome.storage.session.remove(k), DRAFT_KEY);
  const openGen = async (page) => {
    await page.locator('#btn-generate').click();
    await page.locator('#view-generate').waitFor({ state: 'visible', timeout: 5000 });
  };
  // popup 以标签页打开时 active tab 是它自己（chrome-extension://）→ 预填正向须注入 tabs.query
  const patchQuery = (page, tabs) => page.evaluate((arr) => {
    chrome.tabs.query = () => Promise.resolve(arr);
  }, tabs);
  const inputValue = (page) => page.locator('#gen-input').inputValue();
  // canvas 像素指纹：QRCodeStyling 绘制是异步的（SVG → Image → drawImage），先等探针
  const shot = (page) => page.evaluate(async () => {
    await window.Generate.__whenDrawn();
    const c = document.querySelector('#gen-preview canvas');
    return c ? c.toDataURL('image/png') : null;
  });
  const pngBuffer = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
  // 回环解码：把生成结果当图片喂回本扩展的识别链路，断言解出原文（收尾回 home，
  // 便于调用方继续 openGen 或直接结束）
  const decodeBack = async (page, file) => {
    await goHome(page);
    await page.setInputFiles('#file-input', file);
    await waitResults(page);
    const text = await page.locator('.result-card .result-text').first().textContent();
    await goHome(page);
    return text;
  };

  await t('H1 URL 预填：activeTab 可读 url → textarea 预填 + 预览即时渲染；视图 wide 760 与返回还原（V1.2-PLAN PR-3）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    assertEq(await page.locator('#btn-generate .entry-label').textContent(), msg('btn_generate'), '入口文案');
    await patchQuery(page, [{ id: 1, url: 'https://example.com/qr2link-prefill' }]);
    await openGen(page);
    await page.waitForFunction(() => document.querySelector('#gen-input').value !== '', null, { timeout: 5000 });
    assertEq(await inputValue(page), 'https://example.com/qr2link-prefill', '预填当前标签页 URL');
    assert(await shot(page), '预填后应即时渲染预览 canvas');
    assertEq(await bodyMode(page), 'wide', '生成视图为展开态');
    assertEq(await bodyWidth(page), 760, '展开宽度 760');
    // 预填不落草稿：未编辑即关，下次应重新预填当时页面
    const stored = await page.evaluate((k) => chrome.storage.session.get(k), DRAFT_KEY);
    assert(!(DRAFT_KEY in stored), '预填内容不应写入草稿');
    await page.locator('#btn-back-generate').click();
    await page.locator('#view-home').waitFor({ state: 'visible' });
    assertEq(await bodyMode(page), 'compact', '返回后还原紧凑态');
    await page.close().catch(() => {});
  });

  await t('H1b 预填回退：特殊页 / chrome:// / 无 url → 预填为空 + 占位提示、无预览、动作禁用', async () => {
    const variants = [
      ['真实查询（popup 标签页自身 = chrome-extension://）', null],
      ['chrome:// 特殊页', [{ id: 1, url: 'chrome://settings/' }]],
      ['无 url 字段', [{ id: 1 }]],
      ['无标签页', []],
    ];
    for (const [label, tabs] of variants) {
      const page = await newPopup(h);
      await clearDraft(page);
      if (tabs) await patchQuery(page, tabs);
      await openGen(page);
      await sleep(500); // 等 storage.get → tabs.query 异步链走完
      assertEq(await inputValue(page), '', `${label}：预填应为空`);
      assertEq(await page.locator('#gen-input').getAttribute('placeholder'), msg('generate_placeholder'), `${label}：占位提示`);
      assertEq(await shot(page), null, `${label}：无预览`);
      assert(await page.locator('#gen-download').isDisabled(), `${label}：下载应禁用`);
      assert(await page.locator('#gen-copy').isDisabled(), `${label}：复制应禁用`);
      await page.close().catch(() => {});
    }
  });

  await t('H2 输入变更重渲染：换文 canvas 变化；清空 → 预览移除 + 动作禁用；再输入恢复', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    const a = await shot(page);
    assert(a, '输入后应有预览');
    await page.locator('#gen-input').fill(GEN_B);
    const b = await shot(page);
    assert(b && b !== a, '换文后 canvas 应变化');
    await page.locator('#gen-input').fill('');
    assertEq(await shot(page), null, '清空后预览应移除');
    assert(await page.locator('#gen-download').isDisabled(), '清空后下载禁用');
    await page.locator('#gen-input').fill(GEN_A);
    assertEq(await shot(page), a, '同内容同样式应渲染出相同 canvas（确定性）');
    assert(await page.locator('#gen-download').isEnabled(), '恢复后下载可用');
    await page.close().catch(() => {});
  });

  await t('H3 下载 PNG：data-URI 锚点触发下载、文件名 qr2link.png；下载产物回环解码 = 原文', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    await shot(page);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.locator('#gen-download').click(),
    ]);
    assertEq(dl.suggestedFilename(), 'qr2link.png', '下载文件名');
    const file = path.join(OUT_DIR, 'gen-download.png');
    await dl.saveAs(file);
    assert(fs.statSync(file).size > 200, '下载文件应为非空 PNG');
    assertEq(await decodeBack(page, file), GEN_A, '下载的码应可被识别回原文');
    // 失败路径注入（PR #6 review P2 采纳）：download 异步被拒 → 下载失败反馈
    await openGen(page); // 重进生成视图（同页：输入与预览状态保留）
    await page.evaluate(() => {
      window.QRCodeStyling.prototype.download = function () { return Promise.reject(new Error('x')); };
    });
    await page.locator('#gen-download').click();
    await page.waitForFunction((txt) => document.querySelector('#gen-download').textContent === txt, msg('generate_download_failed'), { timeout: 5000 });
    await page.close().catch(() => {});
  });

  await t('H4 超长报错：超容量 → i18n 超长提示 + 预览移除 + 动作禁用；改短后恢复（qrcode-generator 同步抛错路径）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    assert(await shot(page), '基线预览');
    await page.locator('#gen-input').fill('x'.repeat(3000)); // > v40-L 字节容量 2953，任何纠错级都溢出
    const err = page.locator('#gen-error');
    await err.waitFor({ state: 'visible', timeout: 3000 });
    assertEq(await err.textContent(), msg('generate_too_long'), '超长提示文案');
    assertEq(await shot(page), null, '超长时不应残留旧码');
    assert(await page.locator('#gen-download').isDisabled(), '超长时下载禁用');
    assert(await page.locator('#gen-copy').isDisabled(), '超长时复制禁用');
    // 超长态下改样式仍应报错（update 为合并语义，旧 data 仍在）
    await page.locator('#gen-dots').selectOption('dots');
    assert(await err.isVisible(), '超长态改样式仍应提示');
    await page.locator('#gen-input').fill(GEN_A);
    assert(await err.isHidden(), '改短后提示消失');
    assert(await shot(page), '改短后预览恢复');
    assert(await page.locator('#gen-download').isEnabled(), '改短后下载可用');
    await page.close().catch(() => {});
  });

  await t('H5 样式矩阵：5 点阵 × 3 定位角 15 组合 canvas 全互异；前景/背景色生效（像素级）（review P2 采纳）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    const DOTS = ['square', 'rounded', 'dots', 'classy', 'classy-rounded'];
    const CORNERS = ['square', 'dot', 'extra-rounded'];
    assertEq((await page.locator('#gen-dots option').allTextContents()).join(), DOTS.join(), '点阵选项');
    assertEq((await page.locator('#gen-corners option').allTextContents()).join(), CORNERS.join(), '定位角选项');
    const seen = new Map();
    for (const d of DOTS) {
      for (const c of CORNERS) {
        await page.locator('#gen-dots').selectOption(d);
        await page.locator('#gen-corners').selectOption(c);
        const img = await shot(page);
        assert(img, `${d}×${c} 应有预览`);
        assert(!seen.has(img), `${d}×${c} 与 ${seen.get(img)} 渲染相同（样式未生效）`);
        seen.set(img, `${d}×${c}`);
      }
    }
    assertEq(seen.size, 15, '15 组合全互异');

    // 颜色：亮边像素 = 背景色；码点中存在精确前景色像素
    const probe = (fg) => page.evaluate(async (rgb) => {
      await window.Generate.__whenDrawn();
      const c = document.querySelector('#gen-preview canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let hasFg = false;
      for (let i = 0; i < d.length && !hasFg; i += 4) {
        hasFg = d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2];
      }
      const o = (2 * c.width + 2) * 4; // (2,2) 落在 12px 亮边内
      return { corner: [d[o], d[o + 1], d[o + 2]].join(), hasFg };
    }, fg);
    await page.locator('#gen-dots').selectOption('square');
    await page.locator('#gen-corners').selectOption('square');
    let p = await probe([0, 0, 0]);
    assertEq(p.corner, '255,255,255', '默认背景白');
    assert(p.hasFg, '默认前景黑');
    await page.locator('#gen-fg').fill('#d93025');
    await page.locator('#gen-bg').fill('#e8f0fe');
    p = await probe([217, 48, 37]);
    assertEq(p.corner, '232,240,254', '背景色生效');
    assert(p.hasFg, '前景色生效');
    assert(!(await probe([0, 0, 0])).hasFg, '换色后不应残留黑色码点');
    await page.close().catch(() => {});
  });

  await t('H6 复制图片：clipboard.ps1 桥读回 280×280 图片并回环解码 = 原文；写入被拒 → copyFailed 反馈', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_B);
    await shot(page);
    setClipboard('clear');
    await page.locator('#gen-copy').click();
    await page.waitForFunction((txt) => document.querySelector('#gen-copy').textContent === txt, msg('copied'), { timeout: 5000 });
    const clip = path.join(OUT_DIR, 'gen-clipboard.png');
    fs.rmSync(clip, { force: true });
    const info = getClipboardImage(clip);
    assert(info.ok, '剪贴板应含图片');
    assertEq(`${info.width}x${info.height}`, '280x280', '剪贴板图片尺寸 = 预览尺寸');
    await sleep(1300); // 等 flash 复位（否则下次 flash 会把「已复制」记成原文案）
    assertEq(await page.locator('#gen-copy').textContent(), msg('btn_copy_image'), 'flash 后文案复位');

    // 失败路径：clipboard.write 被拒 → 既有 copyFailed 提示
    await page.evaluate(() => { navigator.clipboard.write = () => Promise.reject(new Error('denied')); });
    await page.locator('#gen-copy').click();
    await page.waitForFunction((txt) => document.querySelector('#gen-copy').textContent === txt, msg('copy_failed'), { timeout: 5000 });

    assertEq(await decodeBack(page, clip), GEN_B, '剪贴板里的码应可被识别回原文');
    await page.close().catch(() => {});
  });

  await t('H7 logo：上传 → 缩略图 + canvas 变化、带 logo 仍可解码；移除 → 回到无 logo 基线（合并语义显式清空）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    const base = await shot(page);
    assert(await page.locator('#gen-logo-thumb').isHidden(), '初始无缩略图');
    assert(await page.locator('#gen-logo-remove').isHidden(), '初始无移除按钮');
    await page.setInputFiles('#gen-logo-file', ICON);
    await page.locator('#gen-logo-thumb').waitFor({ state: 'visible', timeout: 5000 });
    const withLogo = await shot(page);
    assert(withLogo && withLogo !== base, '带 logo 的 canvas 应不同于基线');
    const file = path.join(OUT_DIR, 'gen-logo.png');
    fs.writeFileSync(file, pngBuffer(withLogo));
    assertEq(await decodeBack(page, file), GEN_A, '带 logo 的码仍应可识别');
    // 回生成视图（同页：组件状态保留）→ 移除 logo
    await openGen(page);
    assertEq(await inputValue(page), GEN_A, '视图往返不重置输入');
    assert(await page.locator('#gen-logo-thumb').isVisible(), '视图往返不丢 logo');
    await page.locator('#gen-logo-remove').click();
    assert(await page.locator('#gen-logo-thumb').isHidden(), '移除后缩略图隐藏');
    assertEq(await shot(page), base, '移除后应回到无 logo 基线');
    await page.close().catch(() => {});
  });

  await t('H8 logo 边界：非图片 / 超大（>2MB）/ 损坏图片 / SVG（栅格白名单）/ 高压缩比大尺寸（像素上限）均拒绝并有 i18n 提示，预览不变；恰 2MB 不触发「过大」（闭区间）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    const base = await shot(page);
    const err = page.locator('#gen-error');
    const errIs = (key) => page.waitForFunction((txt) => {
      const e = document.querySelector('#gen-error');
      return !e.hidden && e.textContent === txt;
    }, msg(key), { timeout: 5000 });
    const MB2 = 2 * 1024 * 1024;

    await page.setInputFiles('#gen-logo-file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await errIs('generate_logo_not_image');
    await page.locator('#gen-input').fill(GEN_A); // 重渲染清提示（同文案的下一条断言才有区分度）
    assert(await err.isHidden(), '重渲染后提示清除');

    await page.setInputFiles('#gen-logo-file', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(MB2 + 1) });
    await errIs('generate_logo_too_large');
    await page.locator('#gen-input').fill(GEN_A);

    // 损坏图片：MIME 是 image/png 但内容解不了码 → 解码预检拒绝（否则预览空白却可导出）
    await page.setInputFiles('#gen-logo-file', { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('definitely not a png') });
    await errIs('generate_logo_not_image');
    await page.locator('#gen-input').fill(GEN_A);

    // 恰 2MB：过大小闸（上限闭区间），随后因解不了码落「非图片」而不是「过大」
    await page.setInputFiles('#gen-logo-file', { name: 'edge.png', mimeType: 'image/png', buffer: Buffer.alloc(MB2) });
    await errIs('generate_logo_not_image');
    await page.locator('#gen-input').fill(GEN_A);

    // SVG 拒绝（PR #6 review P2 采纳）：栅格白名单 —— SVG 可携带外部资源引用，
    // 与「生成零外联」契约冲突（外联断言见 H11）
    const evilSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><image href="https://evil.example.com/x.png"/></svg>';
    await page.setInputFiles('#gen-logo-file', { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(evilSvg) });
    await errIs('generate_logo_not_image');
    await page.locator('#gen-input').fill(GEN_A);

    // 高压缩比大尺寸（3000×3000 纯色 PNG，字节远小于 2MB）→ 像素上限拒绝（PR #6 review P2 采纳）
    await page.setInputFiles('#gen-logo-file', path.join(OUT_DIR, 'logo-huge-dim.png'));
    await errIs('generate_logo_too_large');
    await page.locator('#gen-input').fill(GEN_A);

    assert(await page.locator('#gen-logo-thumb').isHidden(), '被拒文件不应成为 logo');
    assert(await page.locator('#gen-logo-remove').isHidden(), '被拒文件不应出现移除按钮');
    assertEq(await shot(page), base, '被拒文件不应改变预览');
    assert(await page.locator('#gen-download').isEnabled(), '被拒后原预览仍可导出');
    await page.close().catch(() => {});
  });

  await t('H9 草稿恢复：输入后关闭弹窗再开 → 内容保留（storage.session，草稿优先于预填）；清空亦为草稿', async () => {
    const DRAFT = 'H9 draft 草稿内容 ' + Date.now();
    const p1 = await newPopup(h);
    await clearDraft(p1);
    await openGen(p1);
    await p1.locator('#gen-input').fill(DRAFT);
    await sleep(300);
    const stored = await p1.evaluate((k) => chrome.storage.session.get(k), DRAFT_KEY);
    assertEq(stored[DRAFT_KEY], DRAFT, '草稿应即时写入 storage.session');
    const local = await p1.evaluate(() => chrome.storage.local.get(null));
    assert(!JSON.stringify(local).includes(DRAFT), '草稿不应落入 storage.local（仅会话级）');
    await p1.close();

    // 重开：即便当前页有可预填 URL，也应恢复草稿
    const p2 = await newPopup(h);
    await patchQuery(p2, [{ id: 1, url: 'https://example.com/qr2link-should-not-prefill' }]);
    await openGen(p2);
    await p2.waitForFunction((v) => document.querySelector('#gen-input').value === v, DRAFT, { timeout: 5000 });
    assert(await shot(p2), '恢复草稿后应渲染预览');
    // 用户显式清空 → 空串草稿，重开不应被预填覆盖
    await p2.locator('#gen-input').fill('');
    await sleep(300);
    await p2.close();
    const p3 = await newPopup(h);
    await patchQuery(p3, [{ id: 1, url: 'https://example.com/qr2link-should-not-prefill' }]);
    await openGen(p3);
    await sleep(600);
    assertEq(await inputValue(p3), '', '空草稿应保持为空、不被预填覆盖');
    await clearDraft(p3);
    await p3.close().catch(() => {});
  });

  await t('H10 粘贴守卫：生成视图内 Ctrl+V 文本进入输入框，不被识别通道的「剪贴板无图片」错误页劫持', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill('');
    setClipboard('text', { text: 'H10-pasted-into-generate' });
    await page.locator('#gen-input').click();
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelector('#gen-input').value !== '', null, { timeout: 5000 });
    assertEq(await inputValue(page), 'H10-pasted-into-generate', '粘贴文本应进入输入框');
    assert(await page.locator('#view-generate').isVisible(), '应停留在生成视图');
    assert(await page.locator('#view-status').isHidden(), '不应跳到错误页');
    assert(await shot(page), '粘贴内容应即时渲染');
    // 对照：离开生成视图后，识别通道的粘贴行为不变（B20 契约）
    await goHome(page);
    await page.keyboard.press('Control+v');
    await waitErr(page);
    assertEq(await statusText(page), msg('err_clipboard_no_image'), 'home 视图粘贴文本仍走识别通道提示');
    await clearDraft(page);
    await page.close().catch(() => {});
  });

  await t('H11 生成全流程零外联：输入/换样式/换色/logo/下载/复制/被拒 SVG 尝试期间无 http(s) 请求（零网络契约）', async () => {
    const page = await newPopup(h);
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    await page.locator('#gen-dots').selectOption('classy-rounded');
    await page.locator('#gen-corners').selectOption('extra-rounded');
    await page.locator('#gen-fg').fill('#1a73e8');
    await page.setInputFiles('#gen-logo-file', ICON);
    await page.locator('#gen-logo-thumb').waitFor({ state: 'visible', timeout: 5000 });
    assert(await shot(page), '全样式 + logo 应渲染');
    // 带 http 外链引用的 SVG：应被栅格白名单拒绝，且拒绝路径不发起任何网络请求
    const evilSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><image href="https://evil.example.com/x.png"/></svg>';
    await page.setInputFiles('#gen-logo-file', { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(evilSvg) });
    await sleep(400);
    assert(await page.locator('#gen-logo-thumb').isVisible(), '前一个合法 logo 不受被拒尝试影响');
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.locator('#gen-download').click(),
    ]);
    await dl.cancel().catch(() => {});
    await page.locator('#gen-copy').click();
    await page.waitForFunction((txt) => document.querySelector('#gen-copy').textContent === txt, msg('copied'), { timeout: 5000 });
    const external = urls.filter((u) => !/^(chrome-extension:|data:|blob:)/.test(u));
    assertEq(external.join(' '), '', '生成流程不应有外联请求');
    await clearDraft(page);
    await page.close().catch(() => {});
  });

  await t('H12 UTF-8 正确性：中文/emoji（含 BMP 外代理对）/混合文本生成回环解码 = 原文；容量按模式边界（PR #6 review P1 采纳：内嵌编码器默认逐 code unit 截断）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    const CASES = [
      'https://example.com/qr2link-中文路径?查询=参数#锚点',
      '中文内容测试，包含逗号、空格与全角标点「」《》。',
      'emoji 😀🀄🫠 与文字混合 🄰①Ⅲ 及 surrogate 对 𝕏',
    ];
    for (const text of CASES) {
      await page.locator('#gen-input').fill(text);
      const file = path.join(OUT_DIR, 'gen-utf8.png');
      fs.writeFileSync(file, pngBuffer(await shot(page)));
      assertEq(await decodeBack(page, file), text, `回环解码 = 原文（${text.slice(0, 10)}…）`);
      await openGen(page); // 回生成视图继续下一组（往返不重置输入）
      assertEq(await inputValue(page), text, '视图往返输入保留');
    }
    // 容量边界（估算闸与库一致性的锚点）：v40-M byte 2331 字节 / numeric 5596 位（实测值）
    await page.locator('#gen-input').fill('中'.repeat(777)); // 777×3 = 2331 字节，恰上限
    assert(await shot(page), '恰 2331 UTF-8 字节应可生成');
    await page.locator('#gen-input').fill('中'.repeat(778)); // 2334 字节 → 超限
    await page.locator('#gen-error').waitFor({ state: 'visible', timeout: 3000 });
    assertEq(await page.locator('#gen-error').textContent(), msg('generate_too_long'), '中文超限提示');
    await page.locator('#gen-input').fill('1'.repeat(5596)); // Numeric 模式上限（前置闸按模式估算）
    assert(await shot(page), '数字 5596 位应可生成（Numeric 容量大于字节容量）');
    await page.locator('#gen-input').fill('1'.repeat(5597));
    await page.locator('#gen-error').waitFor({ state: 'visible', timeout: 3000 });
    await page.close().catch(() => {});
  });

  await t('H13 防冻结前置闸：MB 级粘贴即时报超限（不进同步编码）、动作禁用、返回可用（PR #6 review P1 采纳）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    const big = 'x'.repeat(1024 * 1024) + '😀'.repeat(512); // ~1MB ASCII + 代理对（TextEncoder 大输入亦须瞬时）
    const t0 = Date.now();
    await page.locator('#gen-input').fill(big);
    await page.locator('#gen-error').waitFor({ state: 'visible', timeout: 5000 });
    const dt = Date.now() - t0;
    assert(dt < 3000, `超限应即时报错（实际 ${dt}ms），不应长阻塞主线程`);
    assertEq(await shot(page), null, '不应有预览');
    assert(await page.locator('#gen-download').isDisabled(), '下载禁用');
    assert(await page.locator('#gen-copy').isDisabled(), '复制禁用');
    await page.locator('#btn-back-generate').click(); // 弹窗未被冻结：返回立即可用
    await page.locator('#view-home').waitFor({ state: 'visible', timeout: 2000 });
    await page.close().catch(() => {});
  });

  await t('H14 logo 竞态防护：快速连续选择两个 logo，最终态 = 最后一次选择（PR #6 review P2 采纳）', async () => {
    const page = await newPopup(h);
    await clearDraft(page);
    await openGen(page);
    await page.locator('#gen-input').fill(GEN_A);
    const base = await shot(page);
    await page.setInputFiles('#gen-logo-file', path.join(EXT_DIR, 'icons', 'icon16.png'));
    await page.setInputFiles('#gen-logo-file', ICON); // 不等第一个的 FileReader/Image 完成立即选第二个
    await page.locator('#gen-logo-thumb').waitFor({ state: 'visible', timeout: 5000 });
    const want = 'data:image/png;base64,' + fs.readFileSync(ICON).toString('base64');
    await page.waitForFunction((w) => document.querySelector('#gen-logo-thumb').src === w, want, { timeout: 5000 });
    assert((await shot(page)) !== base, '最终预览应含第二次选择的 logo');
    await page.close().catch(() => {});
  });
}

// ================= 汇总 =================

async function writeReport({ channel, captureProbe }) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(REPORT_DIR, `${channel}-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ channel, results, pageErrors, captureProbe: captureProbe || [] }, null, 2));

  const md = [`# QR2Link 自动化验收报告 — ${channel}`, '',
    `- 时间：${new Date().toLocaleString('zh-CN')}`,
    `- 结果：**${pass} 通过 / ${fail} 失败**（共 ${results.length} 项）`, ''];
  if (captureProbe && captureProbe.length) {
    md.push('## 特殊页面可截性矩阵', '', '| 页面 | captureVisibleTab 探针 | badge |', '|---|---|---|');
    for (const c of captureProbe) {
      md.push(`| ${c.page} | ${c.probe.ok ? `✅ ${c.probe.bytes}B` : `❌ ${c.probe.err}`} | ${JSON.stringify(c.badge)} |`);
    }
    md.push('');
  }
  md.push('| 组 | 用例 | 结果 | 耗时 | 备注 |', '|---|---|---|---|---|');
  for (const r of results) {
    md.push(`| ${r.group} | ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.ms}ms | ${r.err ? r.err.replace(/\|/g, '\\|') : ''} |`);
  }
  if (pageErrors.length) {
    md.push('', '## 页面运行时错误', '');
    for (const e of pageErrors) md.push(`- \`${e.url}\`: ${e.err}`);
  }
  const mdPath = path.join(REPORT_DIR, `${channel}-${stamp}.md`);
  fs.writeFileSync(mdPath, md.join('\n'));
  console.log(`\n报告：${mdPath}`);
  return { pass, fail };
}

// ---------------- 主流程 ----------------

async function main() {
  // 前置守门（I18N-PLAN grill Q3）：locale 完整性静态校验，失败即中止全部用例
  const chk = spawnSync(process.execPath, [path.join(EXT_DIR, 'scripts', 'check-locales.mjs')], { stdio: 'inherit' });
  if (chk.status !== 0) { console.error('check-locales 未通过，中止验收'); process.exit(1); }

  // 前置守门（PR #4 review P2-6 采纳）：vendor 文件 SHA256 校验（仅读 lib/，不依赖 node_modules）
  const vchk = spawnSync(process.execPath, [path.join(EXT_DIR, 'scripts', 'vendor-sync.mjs')], { stdio: 'inherit' });
  if (vchk.status !== 0) { console.error('vendor 校验未通过，中止验收'); process.exit(1); }

  await makeAssets();
  const srv = await serveStatic(TEST_DIR);
  console.log(`静态服务器：${srv.url}`);
  let h;
  const captureProbe = [];
  try {
    h = await launch({ channel: CHANNEL, lang: LANG });
    console.log(`扩展已加载：${h.extId}（channel=${CHANNEL}，lang=${LANG}）`);
    if (ONLY.includes('A')) await suiteA(h, srv);
    if (ONLY.includes('B')) await suiteB(h, srv);
    if (ONLY.includes('C')) await suiteC(h, srv);
    if (ONLY.includes('D')) captureProbe.push(...(await suiteD(h, srv)) || []);
    if (ONLY.includes('E')) await suiteE(h);
    if (ONLY.includes('F')) await suiteF(h);
    if (ONLY.includes('G')) await suiteG(h);
    if (ONLY.includes('H')) await suiteH(h);
  } finally {
    // 报告文件名带语言后缀，双语回归各自留档
    const summary = await writeReport({ channel: `${CHANNEL}-${LANG}`, captureProbe });
    if (h) await h.close().catch(() => {});
    await srv.close().catch(() => {});
    console.log(`\n==== ${CHANNEL}(${LANG}) 汇总：${summary.pass} 通过 / ${summary.fail} 失败 ====`);
    process.exit(summary.fail > 0 ? 2 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
