/**
 * vendor-sync.mjs — 第三方库 vendor 同步与完整性校验（V1.2-PLAN PR-1）
 *
 * 用法：
 *   node scripts/vendor-sync.mjs --sync    # 从 node_modules 拷贝 vendor 文件到 lib/（先 npm install）
 *   node scripts/vendor-sync.mjs           # 仅校验：lib/ 文件与 VENDOR_LOCK 哈希一致
 *
 * 设计（外部 review 采纳）：
 *   - 校验「进入发行包的每一个 vendor 文件」的 SHA256，不只 wasm——wrapper JS 同样直接进包；
 *   - 来源（npm 包名@精确版本）随 VENDOR_LOCK 固化，可复现性不依赖 package-lock.json
 *     （lockfile 按 .gitignore 惯例不入库；devDependencies 均为精确钉版无 ^ 前缀）；
 *   - vendor 文件保持与 npm dist 字节一致，不加头注释——改一字节即哈希不过。
 *
 * 注：zxing-wasm 的 writer（zint，BSD-3）仅在测试侧（test/gen-qr.mjs）经 node_modules 使用，
 *     不进入发行包，故不列入本表（zint 许可证无需随包分发）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// vendor 清单：lib 内相对路径 → { source: npm 包内路径（--sync 用）, sha256, from, license }
// 哈希由 --sync 后计算回填；升级版本 = 改 source + 重新 --sync + 回填哈希 + THIRD_PARTY_LICENSES 同步
const VENDOR_LOCK = {
  'lib/zxing-reader.js': {
    from: 'zxing-wasm@3.1.6 (dist/iife/reader/index.js, IIFE 自包含)',
    source: 'zxing-wasm/dist/iife/reader/index.js',
    sha256: 'ffd72d59d54082194f7c086b384dcd930bdeb0c5b39fbb13779694e69bb0d344',
  },
  'lib/zxing_reader.wasm': {
    from: 'zxing-wasm@3.1.6 (dist/reader/zxing_reader.wasm, ZXing-C++ 编译产物)',
    source: 'zxing-wasm/dist/reader/zxing_reader.wasm',
    sha256: '5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e',
  },
};

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

if (process.argv.includes('--sync')) {
  let ok = true;
  for (const [dest, meta] of Object.entries(VENDOR_LOCK)) {
    const src = join(ROOT, 'node_modules', meta.source);
    if (!existsSync(src)) { console.error(`✕ node_modules 缺 ${meta.source}（先 npm install）`); ok = false; continue; }
    copyFileSync(src, join(ROOT, dest));
    console.log(`已同步 ${dest}  <-  ${meta.from}\n  新 sha256: ${sha256(join(ROOT, dest))}${meta.sha256 === 'FILL_ME' ? '  （回填到本文件 VENDOR_LOCK）' : ''}`);
  }
  process.exit(ok ? 0 : 1);
}

let failed = false;
for (const [dest, meta] of Object.entries(VENDOR_LOCK)) {
  const file = join(ROOT, dest);
  if (!existsSync(file)) { console.error(`✕ 缺失 ${dest}`); failed = true; continue; }
  const actual = sha256(file);
  if (meta.sha256 === 'FILL_ME') { console.error(`✕ ${dest} 的 sha256 尚未回填 VENDOR_LOCK`); failed = true; continue; }
  if (actual !== meta.sha256) { console.error(`✕ ${dest} 哈希不符\n  期望 ${meta.sha256}\n  实际 ${actual}`); failed = true; continue; }
  console.log(`✓ ${dest}  (${meta.from})`);
}
if (failed) { console.error('\nvendor 校验失败：请用 --sync 重新同步并回填哈希，勿手改 lib/ 文件'); process.exit(1); }
console.log('\nvendor 校验通过');
