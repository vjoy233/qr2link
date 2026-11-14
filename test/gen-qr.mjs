/**
 * test/gen-qr.mjs — 本地生成测试二维码样例（handoff §4.7，不依赖网络）
 * 用法：npm i && node test/gen-qr.mjs
 * 产物（写入 test/）：normal / small / inverted / two-codes / huge-with-small / no-qr / text-code
 *                    matrix/fmt-*.png — 11 种码制矩阵（V1.2-PLAN PR-1 全码制承诺，
 *                    zxing-wasm writer 即 zint 生成，node 侧 devDependency，不入发行包）
 *                    structured/*.png — WIFI/otpauth/hotp/vCard/geo 结构化解析 fixture（PR-2 C1）
 *                    safety/*.png — 危险 URL fixture：punycode 混排/user-pass/http/IP/短链（PR-2 C2）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { writeBarcode } from 'zxing-wasm';

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

// 8. 码制矩阵（V1.2-PLAN PR-1）：zxing-wasm writer（zint）生成 11 种格式。
//    payload 按码制字符集约束选取；若个别格式生成失败，从矩阵移除并回填 V1.2-PLAN
const matrixDir = path.join(testDir, 'matrix');
await mkdir(matrixDir, { recursive: true });
const MATRIX = [
  ['QRCode', 'https://example.com/qr2link-matrix-qr'],
  ['EAN13', '5901234123457'],
  ['UPCA', '036000291452'],
  ['Code128', 'QR2LINK-CODE128'],
  ['Code39', 'QR2LINK-39'],
  ['Code93', 'QR2LINK-93'],
  ['ITF', '1234567890'],
  ['Codabar', 'A123456A'],
  ['DataMatrix', 'https://example.com/qr2link-matrix-dm'],
  ['Aztec', 'https://example.com/qr2link-matrix-aztec'],
  ['PDF417', 'https://example.com/qr2link-matrix-pdf417'],
];
const failures = [];
for (const [format, payload] of MATRIX) {
  try {
    const { image } = await writeBarcode(payload, { format, scale: 4, addQuietZones: true });
    if (!image) throw new Error('no image blob');
    await writeFile(path.join(matrixDir, `fmt-${format.toLowerCase()}.png`), Buffer.from(await image.arrayBuffer()));
  } catch (e) {
    failures.push(`${format}: ${e.message || e}`);
  }
}
if (failures.length) {
  console.error('码制矩阵生成失败（需从 V1.2-PLAN 承诺矩阵移除并回填）：\n  ' + failures.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('码制矩阵完成: test/matrix/fmt-*.png x ' + MATRIX.length);
}

// 9. 混合码图（PR #4 review P1-1）：QR（native 可命中）+ Code128（仅 zxing 可读）同图，
//    锁定「native 命中后不短路 zxing」的合并行为（E9）。画布宽按 Code128 实际宽度动态计算
{
  const qrBuf = await QRCode.toBuffer('https://example.com/qr2link-mixed', { width: 300, margin: 2 });
  const c128 = path.join(matrixDir, 'fmt-code128.png');
  const c128Meta = await sharp(c128).metadata();
  const W = 40 + 300 + 60 + c128Meta.width + 40;
  const H = 340;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite([
      { input: qrBuf, left: 40, top: Math.round((H - 300) / 2) },
      { input: c128, left: 40 + 300 + 60, top: Math.round((H - c128Meta.height) / 2) },
    ])
    .png()
    .toFile(path.join(matrixDir, 'mixed-qr-1d.png'));
  console.log(`混合码图完成: test/matrix/mixed-qr-1d.png (${W}x${H})`);
}

// 10. 结构化解析 fixture（V1.2-PLAN PR-2 C1）：qrcode 库生成，e2e F 组上传路径用。
//     WIFI 用例覆盖全部四种转义（\; \, \: \\）；otpauth secret = Base32('12345678901234567890')
//     （RFC 6238 SHA-1 向量密钥，页内函数断言直接复用）；vCard 覆盖折叠行 + 多值 TEL/EMAIL
const structDir = path.join(testDir, 'structured');
await mkdir(structDir, { recursive: true });
await qrPng(path.join(structDir, 'wifi.png'),
  'WIFI:T:WPA;S:My\\;Network;P:p\\;a\\:ss\\,\\\\;H:true;;', 320);
await qrPng(path.join(structDir, 'otpauth.png'),
  'otpauth://totp/QR2Link:alice%40example.com?issuer=QR2Link&secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=6&period=30&algorithm=SHA1', 320);
await qrPng(path.join(structDir, 'hotp.png'),
  'otpauth://hotp/QR2Link:bob?issuer=QR2Link&secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=5&digits=6', 320);
await qrPng(path.join(structDir, 'vcard.png'),
  ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Alice Zhang', 'N:Zhang;Alice;;;',
    'TEL:+8613800138000', 'TEL;TYPE=CELL:+8613900139000', 'EMAIL:alice@example.com',
    'ORG:QR2Link Inc.', 'TITLE:Engineer', 'END:VCARD'].join('\r\n'), 320);
await qrPng(path.join(structDir, 'geo.png'), 'geo:31.230416,121.473701', 320);
console.log('结构化 fixture 完成: test/structured/{wifi,otpauth,hotp,vcard,geo}.png');

// 11. 安全预检 fixture（V1.2-PLAN PR-2 C2）：e2e G 组上传路径用。
//     danger-punycode 主机 xn--pple-43d = 'аpple'（西里尔 U+0430 + 拉丁 pple，punycode 混排）；
//     纯西里尔/纯汉字 IDN 的不误报边界由 G2 在函数级直接断言（不产 fixture）
const safetyDir = path.join(testDir, 'safety');
await mkdir(safetyDir, { recursive: true });
await qrPng(path.join(safetyDir, 'danger-punycode.png'), 'https://xn--pple-43d.com/qr2link-danger', 320);
await qrPng(path.join(safetyDir, 'danger-userpass.png'), 'https://user:pass@example.com/qr2link-danger-up', 320);
await qrPng(path.join(safetyDir, 'caution-http.png'), 'http://example.com/qr2link-caution-http', 320);
await qrPng(path.join(safetyDir, 'caution-ip.png'), 'http://192.168.1.1/admin?x=1', 320);
await qrPng(path.join(safetyDir, 'caution-short.png'), 'https://bit.ly/3xYzAbC', 320);
console.log('安全 fixture 完成: test/safety/{danger-punycode,danger-userpass,caution-http,caution-ip,caution-short}.png');

console.log('done: test images generated in test/');
