/**
 * scripts/gen-icons.mjs — 从 icons/icon.svg 生成 manifest 所需 16/48/128 PNG。
 * 用法：npm i && node scripts/gen-icons.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const svg = await readFile(path.join(root, 'icons', 'icon.svg'));

for (const size of [16, 48, 128]) {
  const out = path.join(root, 'icons', `icon${size}.png`);
  await sharp(svg, { density: 300 })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`written ${out}`);
}
