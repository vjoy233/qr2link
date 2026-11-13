/**
 * bench-zxing.mjs — zxing-wasm 解码性能基准（V1.2-PLAN「zxing 性能基准」，PR-1 开工首日实测）
 *
 * 矩阵：320px 正常码 / 9MP 无码高频纹理 / 40MP 大图小码 / 50MP 无码高频纹理
 * 口径：单程 readBarcodes（生产 ReaderOptions：textMode Plain + maxNumberOfSymbols 8，
 *       tryHarder/tryRotate/tryInvert/tryDownscale 默认全开）——等价于阶段 2 全分辨率趟次。
 *       node 侧输入为 PNG 字节（wasm 内含 stb_image 解码），比浏览器直喂 ImageData 多一次
 *       PNG 解码，因此本测量是保守上界。
 * 验收线（V1.2-PLAN）：50MP 无码单程 ≤ 5000ms（参考机）
 * 用法：node scripts/bench-zxing.mjs
 */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { readBarcodes, ZXING_WASM_VERSION } from 'zxing-wasm';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'test', 'out', 'bench');
mkdirSync(OUT, { recursive: true });

// ---- 生成无码高频纹理图（随机噪声，对条码检测器最坏的「无码」情形）----
async function noisePng(name, w, h) {
  const f = join(OUT, name);
  if (!existsSync(f)) {
    const px = Buffer.allocUnsafe(w * h * 3);
    const chunk = 1 << 20;
    for (let off = 0; off < px.length; off += chunk) {
      px.fill(randomBytes(Math.min(chunk, px.length - off)), off, off + Math.min(chunk, px.length - off));
    }
    await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toFile(f);
  }
  return { file: f, label: `${w}x${h} (${((w * h) / 1e6).toFixed(1)}MP) 无码噪声` };
}

async function timeOnce(file) {
  const bytes = new Uint8Array(readFileSync(file));
  const t0 = performance.now();
  const res = await readBarcodes(bytes, { textMode: 'Plain', maxNumberOfSymbols: 8 });
  return { ms: performance.now() - t0, hits: res.length };
}

async function bench(label, file, runs) {
  const times = [];
  let hits = -1;
  for (let i = 0; i < runs; i++) {
    const r = await timeOnce(file); // 首轮含 wasm 编译，单列
    if (i === 0) console.log(`  (首轮含 wasm 实例化: ${r.ms.toFixed(0)}ms)`);
    else times.push(r.ms);
    hits = r.hits;
  }
  const max = Math.max(...times), min = Math.min(...times);
  const med = times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const flag = max <= 5000 ? 'PASS' : 'FAIL';
  console.log(`${label}  ->  中位 ${med.toFixed(0)}ms / 最大 ${max.toFixed(0)}ms（${runs - 1} 稳态轮，命中 ${hits}）${label.includes('50MP') ? `  [验收线 5000ms: ${flag}]` : ''}`);
  return { label, med, max, hits };
}

console.log(`zxing-wasm ${ZXING_WASM_VERSION} 性能基准（参考机）\n`);
const cases = [
  { label: '320px 正常码 (normal.png)', file: join(ROOT, 'test', 'normal.png'), runs: 4 },
  await noisePng('bench-9mp-noise.png', 3000, 3000).then((c) => ({ label: `9MP ${c.label}`, file: c.file, runs: 3 })),
  { label: '40MP 大图小码 (huge-with-small.png 8000x5000)', file: join(ROOT, 'test', 'huge-with-small.png'), runs: 3 },
  await noisePng('bench-20mp-noise.png', 5000, 4000).then((c) => ({ label: `20MP ${c.label}`, file: c.file, runs: 3 })),
  await noisePng('bench-30mp-noise.png', 6000, 5000).then((c) => ({ label: `30MP ${c.label}`, file: c.file, runs: 3 })),
  await noisePng('bench-50mp-noise.png', 8333, 6000).then((c) => ({ label: `50MP ${c.label}`, file: c.file, runs: 3 })),
];
const rows = [];
for (const c of cases) rows.push(await bench(c.label, c.file, c.runs));

// ---- jsQR 基线（现网行为参照，直喂 RGBA，无 PNG 解码开销）----
const { createRequire } = await import('node:module');
const require2 = createRequire(import.meta.url);
const jsQR = require2(join(ROOT, 'lib', 'jsQR.js'));
async function benchJsQr(label, file, runs = 2) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const times = [];
  let hit = false;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'attemptBoth' });
    times.push(performance.now() - t0);
    hit = hit || !!(r && r.data);
  }
  console.log(`jsQR ${label}  ->  最大 ${Math.max(...times).toFixed(0)}ms（${runs} 轮，命中 ${hit ? 1 : 0}）`);
  return { label: `jsQR ${label}`, max: Math.max(...times), hits: hit ? 1 : 0 };
}
console.log('');
rows.push(await benchJsQr('9MP 无码噪声', join(OUT, 'bench-9mp-noise.png')));
rows.push(await benchJsQr('40MP 大图小码', join(ROOT, 'test', 'huge-with-small.png')));
rows.push(await benchJsQr('50MP 无码噪声', join(OUT, 'bench-50mp-noise.png')));

writeFileSync(join(OUT, 'bench-result.json'), JSON.stringify({ version: ZXING_WASM_VERSION, date: new Date().toISOString(), rows }, null, 2));
console.log('\n结果已写 test/out/bench/bench-result.json');
