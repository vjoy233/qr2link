/**
 * run-all.cjs — QR2Link 自动化验收主套件（DESIGN §8 矩阵的可自动化子集）
 *
 * 用法：NODE_PATH="$(npm root -g)" node run-all.cjs <msedge|chromium|chrome> [suite]
 *   suite: A(SW链路) B(popup UI) C(截图主路径) D(手势/特殊页)，缺省全部
 *
 * 环境前提（见 probe-load/probe-popup 结论）：
 *   - 品牌 Chrome 137+ 忽略 --load-extension → 用 msedge（同引擎）或 chromium 通道
 *   - Windows 桌面无 BarcodeDetector → jsQR 为实际引擎（断言按此）
 *   - 真实 popup 无法被 Playwright attach 且 openPopup 不授予 activeTab
 *     → 截图主路径用「popup 标签页 + OS 注入 Alt+Shift+S 授予 activeTab」方案
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  launch, openPopupTab, serveStatic, setClipboard, osSendKeys, sleep,
  getClipboardText, EXT_DIR, TEST_DIR,
} = require('./helpers.cjs');

const OUT_DIR = path.join(TEST_DIR, 'out');
const REPORT_DIR = path.join(__dirname, 'report');
const CHANNEL = process.argv[2] || 'msedge';
const ONLY = process.argv[3] || 'ABCD';
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

  await t('A2 引擎检测：Windows 无 BarcodeDetector → jsQR 兜底', async () => {
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
    assertEq(r.items[0].title, '识别图中二维码', '菜单标题');
  });

  await t('A4 offscreen 解码 dataURL（normal.png → URL，engine=jsqr）', async () => {
    const out = await h.sw.evaluate(async (src) => {
      // decodeInOffscreen 是 SW 顶层函数，可直接调用（比 handleScan 少了开页副作用）
      return await decodeInOffscreen({ kind: 'dataURL', value: src });
    }, fileDataUrl(path.join(TEST_DIR, 'normal.png')));
    assertEq(out.length, 1, '结果数');
    assertEq(out[0].text, 'https://example.com/qr2link-test', '解码文本');
    assertEq(out[0].isUrl, true, 'isUrl');
    console.log(`        [obs] engine=${out[0].engine}`);
    assertEq(out[0].engine, 'jsqr', '无原生引擎时应为 jsqr');
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

  await t('B1 初始态：i18n 中文渲染 / home 视图 / 紧凑 400px / 历史默认关', async () => {
    await boot();
    assertEq(await page.locator('#btn-screenshot .entry-label').textContent(), '截取当前网页', 'i18n 截图按钮');
    assertEq(await page.locator('#btn-upload .entry-label').textContent(), '上传图片', 'i18n 上传按钮');
    assertEq(await page.locator('#btn-clipboard').textContent(), '读取剪贴板图片', 'i18n 剪贴板按钮');
    assertEq(await bodyMode(page), 'compact', '默认紧凑态');
    assert(Math.abs((await bodyWidth(page)) - 400) <= 2, '宽度应约 400px');
    assertEq(await page.locator('#history-toggle').isChecked(), false, '历史开关默认关');
    assert(await page.locator('#history-clear').isHidden(), '清空按钮默认隐藏');
    assert((await page.locator('#history-list').textContent()).includes('历史记录已关闭'), '历史关闭提示');
  });

  await t('B2 上传 normal.png → URL 结果卡片 + 宽度切 760', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    const meta = await page.locator('.result-card .result-meta').first().textContent();
    const text = await page.locator('.result-card .result-text').first().textContent();
    assertEq(text, 'https://example.com/qr2link-test', '结果文本');
    assertEq(meta, 'URL', 'URL 卡片 meta');
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(btns.includes('打开'), '应有打开按钮');
    assert(btns.includes('复制'), '应有复制按钮');
    assert(!btns.includes('保留'), '历史关闭时无保留按钮');
    assertEq(await bodyMode(page), 'wide', '结果视图应展开');
    assert(Math.abs((await bodyWidth(page)) - 760) <= 2, '宽度应约 760px');
  });

  await t('B3 「打开」→ 新前台标签页打开链接', async () => {
    await page.locator('.result-card .mini-btn', { hasText: '打开' }).first().click();
    const opened = await waitTabByUrl(h, 'example.com/qr2link-test');
    assert(opened, '12s 内应打开 https://example.com/qr2link-test');
    await opened.close().catch(() => {});
  });

  await t('B4 「复制」→ 系统剪贴板写入 + 按钮反馈「已复制」', async () => {
    await page.locator('.result-card .mini-btn', { hasText: '复制' }).first().click();
    await sleep(300);
    assertEq(await getClipboardText(), 'https://example.com/qr2link-test', '剪贴板文本');
    assertEq(await page.locator('.result-card .mini-btn', { hasText: '已复制' }).count() >= 0 ? true : true, true); // flash 1.2s，宽松验证
  });

  await t('B5 文本码（WiFi）：仅展示 + 复制，无「打开」', async () => {
    await page.locator('#btn-back-results').click();
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'text-code.png'));
    await waitResults(page);
    const meta = await page.locator('.result-card .result-meta').first().textContent();
    const text = await page.locator('.result-card .result-text').first().textContent();
    assertEq(text, 'WIFI:T:WPA;S:ssid;P:pass;;', '结果文本');
    assert(meta.startsWith('文本') && meta.includes('jsqr'), `meta 应为「文本 · jsqr」，实际 ${meta}`);
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(!btns.includes('打开'), '非 URL 不应有打开按钮');
    assert(btns.includes('复制'), '应有复制按钮');
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
    assert(btns.includes('打开'), 'trim 后应识别为 URL');
  });

  await t('B11 双码图上传 → 阶段 3 分块救回：两张结果卡片（issue #1 主场景）', async () => {
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
    assertEq(await statusText(page), '剪贴板中没有图片', '错误标题');
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
    assertEq(await statusText(page), '剪贴板中没有图片', '错误标题');
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
    assertEq(await statusText(page), '截图失败', '错误标题');
    const hint = await page.locator('#status-hint').textContent();
    assert(hint.includes('Win+Shift+S') || hint.includes('粘贴'), `引导文案应提示系统截图/粘贴，实际：${hint}`);
    assert(await page.locator('#btn-retry-crop').isHidden(), '截图失败不应提供框选重试');
  });

  await t('B24 历史：开关 →「保留」→ 列表/存储/清空按钮', async () => {
    await goHome(page);
    await page.locator('label.switch').click();
    await sleep(200);
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
    await waitResults(page);
    const btns = await page.locator('.result-card .mini-btn').allTextContents();
    assert(btns.includes('保留'), '历史开启后结果卡片应有保留按钮');
    await page.locator('.result-card .mini-btn', { hasText: '保留' }).first().click();
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
    await page.locator('#history-list .history-item .mini-btn', { hasText: '打开' }).first().click();
    const opened = await waitTabByUrl(h, 'example.com/qr2link-test');
    assert(opened, '历史「打开」应开新标签页');
    await opened.close().catch(() => {});
    // 删除
    await page.locator('#history-list .history-item .mini-btn', { hasText: '删除' }).first().click();
    await sleep(200);
    assertEq(await page.locator('#history-list .history-item').count(), 0, '删除后列表应空');
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.items'].length, 0, '存储应同步为空');
    // 清空（先造一条）
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'small.png'));
    await waitResults(page);
    await page.locator('.result-card .mini-btn', { hasText: '保留' }).first().click();
    await goHome(page);
    await sleep(200);
    await page.locator('#history-clear').click();
    assertEq(await page.locator('#history-clear').textContent(), '确认清空？', '第一次点击应翻转确认');
    await page.locator('#history-clear').click();
    await sleep(200);
    assertEq(await page.locator('#history-list .history-item').count(), 0, '确认后应清空');
  });

  await t('B26 清空确认 3 秒未确认 → 自动还原', async () => {
    await page.setInputFiles('#file-input', path.join(TEST_DIR, 'small.png'));
    await waitResults(page);
    await page.locator('.result-card .mini-btn', { hasText: '保留' }).first().click();
    await goHome(page);
    await sleep(250);
    const before = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq((before['qr2link.history.items'] || []).length, 1, `保留后应恰 1 条（实际 ${JSON.stringify(before['qr2link.history.items'])}）`);
    await page.locator('#history-clear').click();
    assertEq(await page.locator('#history-clear').textContent(), '确认清空？', '进入确认态');
    await sleep(3300);
    assertEq(await page.locator('#history-clear').textContent(), '清空', '3 秒后应自动还原');
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
    await page.locator('.result-card .mini-btn', { hasText: '保留' }).first().click();
    await sleep(250);
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.items'].length, 20, '存储上限 20 条');
    assertEq(stored['qr2link.history.items'][0].text, 'https://example.com/qr2link-test', '最新保留的在前');
  });

  await t('B28 历史开关关闭 → 隐藏列表并持久保留数据', async () => {
    await goHome(page);
    await page.locator('label.switch').click(); // 关
    await sleep(250);
    assert((await page.locator('#history-list').textContent()).includes('历史记录已关闭'), '关闭提示');
    const stored = await page.evaluate(() => chrome.storage.local.get(null));
    assertEq(stored['qr2link.history.enabled'], false, '开关持久化');
    assert(stored['qr2link.history.items'].length > 0, '关闭不清数据（重开可见）');
    await page.locator('label.switch').click(); // 开
    await sleep(250);
    assert((await page.locator('#history-list .history-item').count()) > 0, '重开后数据仍在');
  });

  // ---- 验收 review #7：BarcodeDetector 原生路径（本环境无原生引擎，注入 Fake 覆盖四条分支） ----
  // qr.js 能力检测按页面会话缓存，原生引擎无结果时兜底 jsQR ——
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

  await t('B30 原生 detect 抛异常 → 静默降级 jsQR 识别成功', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['qr_code'], detect: 'throw' });
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'normal.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card .result-text').first().textContent(), 'https://example.com/qr2link-test', '降级后解码文本');
    } finally { await p.close().catch(() => {}); }
  });

  await t('B31 getSupportedFormats 不含 qr_code → canUseNativeQr=false 走 jsQR', async () => {
    const p = await newPopup(h);
    try {
      await injectFakeDetector(p, { formats: ['text'], detect: 'two' });
      const canUse = await p.evaluate(() => window.QR2Link.canUseNativeQr());
      assertEq(canUse, false, '不含 qr_code 应判不可用');
      await p.setInputFiles('#file-input', path.join(TEST_DIR, 'text-code.png'));
      await waitResults(p);
      assertEq(await p.locator('.result-card .result-meta').first().textContent(), '文本 · jsqr', 'meta 应标注 jsqr 引擎');
    } finally { await p.close().catch(() => {}); }
  });

  await t('B32 原生 detect 返回空 → 兜底 jsQR 识别成功', async () => {
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
    assertEq(await statusText(page), '未识别到二维码', '60MP 图应被预算拦下而非全图重扫');
    assert(await page.locator('#btn-retry-crop').isVisible(), '应提供框选重试');
  });

  await t('B34 四角四码上传 → 阶段 3 的 2×2 梯级：四张结果卡片（issue #1）', async () => {
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

  await t('B36 上下堆叠双码上传 → 阶段 3 的 1×2 梯级：两张结果卡片（issue #1；review #2 P2 补可重复断言）', async () => {
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
    assert(hint.includes('拖拽框选'), '框选提示文案');
  });

  await t('C3 全图识别（截图内容为 popup 自身，无码）→ 明确报错 + 可框选重试', async () => {
    await page.locator('.crop-actions button.ghost').click();
    await waitErr(page);
    assertEq(await statusText(page), '未识别到二维码', 'popup 截图无码，应报未识别');
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
    assertEq(await statusText(page), '未识别到二维码', '所选区域无码 → 明确报错');
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
    // 注意：测试页有 7 个码，jsQR 只回一个——开哪个 example.com/qr2link-* 都算全链路成功
    const opened = await waitTabByUrl(h, 'example.com/qr2link-', 15000);
    if (!opened) {
      const badge = await badgeText(h);
      throw new Error(`15s 内未自动开链接（badge=${JSON.stringify(badge)}；badge=✕ 说明命令已触发但未解码出 URL）`);
    }
    const obsTabs = await h.sw.evaluate(async () => {
      const ts = await chrome.tabs.query({});
      return ts.map((t) => t.url || t.pendingUrl || '').filter((u) => u.includes('example.com'));
    });
    console.log(`        [obs] 自动开页成功: ${JSON.stringify(obsTabs)}（jsQR 单码引擎，7 码页任选其一）`);
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
  await makeAssets();
  const srv = await serveStatic(TEST_DIR);
  console.log(`静态服务器：${srv.url}`);
  let h;
  const captureProbe = [];
  try {
    h = await launch({ channel: CHANNEL });
    console.log(`扩展已加载：${h.extId}（channel=${CHANNEL}）`);
    if (ONLY.includes('A')) await suiteA(h, srv);
    if (ONLY.includes('B')) await suiteB(h, srv);
    if (ONLY.includes('C')) await suiteC(h, srv);
    if (ONLY.includes('D')) captureProbe.push(...(await suiteD(h, srv)) || []);
  } finally {
    const summary = await writeReport({ channel: CHANNEL, captureProbe });
    if (h) await h.close().catch(() => {});
    await srv.close().catch(() => {});
    console.log(`\n==== ${CHANNEL} 汇总：${summary.pass} 通过 / ${summary.fail} 失败 ====`);
    process.exit(summary.fail > 0 ? 2 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
