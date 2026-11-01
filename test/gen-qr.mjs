/**
 * test/gen-qr.mjs — 本地生成测试二维码样例（handoff §4.7，不依赖网络）
 * 用法：npm i && node test/gen-qr.mjs
 * 产物（写入 test/）：normal / small / inverted / two-codes / huge-with-small / no-qr / text-code
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';

const root = path.resolve(
  new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);
const testDir = path.join(root, 'test');
await mkdir(testDir, { recursive: true });

const out = (name) => path.join(testDir, name);
const tmp = (name) => path.join(testDir, '.tmp-' + name);

async function qrPng(file, text, width, color) {
  const opts = { width, margin: 2, errorCorrectionLevel: 'M' };
  if (color) opts.color = color;
  await QRCode.toFile(file, text, opts);
}

// 1. 普通码
await qrPng(out('normal.png'), 'https://example.com/qr2link-test', 320);

// 2. 小尺寸码（≤120px，贴近识别下限）
await qrPng(out('small.png'), 'https://example.com/qr2link-small', 120);

// 3. 反色码：白码黑底
await qrPng(out('inverted.png'), 'https://example.com/qr2link-inverted', 320, {
  dark: '#ffffff',
  light: '#000000',
});

// 4. 文本码（非 URL：WiFi 信息）
await qrPng(out('text-code.png'), 'WIFI:T:WPA;S:ssid;P:pass;;', 320);

// 5. 双码拼图（验证多码展示差异：原生多卡片 / jsQR 单卡片）
await qrPng(tmp('a.png'), 'https://example.com/qr2link-left', 300);
await qrPng(tmp('b.png'), 'https://example.com/qr2link-right', 300);
await sharp({
  create: { width: 640, height: 340, channels: 3, background: '#ffffff' },
})
  .composite([
    { input: tmp('a.png'), left: 10, top: 20 },
    { input: tmp('b.png'), left: 330, top: 20 },
  ])
  .png()
  .toFile(out('two-codes.png'));

// 6. 大图小码（≈8000×5000 白底 + 右下角 120px 码，验证两阶段解码的阶段 2）
await qrPng(tmp('s.png'), 'https://example.com/qr2link-huge', 120);
await sharp({
  create: { width: 8000, height: 5000, channels: 3, background: '#ffffff' },
})
  .composite([{ input: tmp('s.png'), left: 8000 - 120 - 80, top: 5000 - 120 - 80 }])
  .png({ compressionLevel: 9 })
  .toFile(out('huge-with-small.png'));

// 7. 无码图（风景占位）
const scenery =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#8ec5fc"/><stop offset="1" stop-color="#e0c3fc"/>' +
  '</linearGradient></defs>' +
  '<rect width="640" height="400" fill="url(#g)"/>' +
  '<circle cx="500" cy="90" r="42" fill="#ffd54f"/>' +
  '<path d="M0 400 L180 240 L320 400 Z" fill="#5b8c5a"/>' +
  '<path d="M240 400 L420 200 L640 400 Z" fill="#3f6b42"/>' +
  '</svg>';
await sharp(Buffer.from(scenery)).png().toFile(out('no-qr.png'));

// 清理临时文件
const { unlink } = await import('node:fs/promises');
for (const f of ['.tmp-a.png', '.tmp-b.png', '.tmp-s.png']) {
  await unlink(tmp(f.replace('.tmp-', ''))).catch(() => {});
}

console.log('done: test images generated in test/');
