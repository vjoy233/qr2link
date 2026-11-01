/**
 * scripts/pack-zip.mjs — 打包扩展为发布 zip（GitHub Release 附件用）
 * 用法：node scripts/pack-zip.mjs  →  dist/qr2link-v{version}.zip
 *
 * 仅包含运行所需文件（manifest + 后台/解码 JS + popup + lib + icons）；
 * 排除 test/、scripts/、node_modules/ 与开发文档。zip 内含 qr2link-v{version}/
 * 包装目录，解压即得可直接「加载已解压」的文件夹。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(
  new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

const INCLUDE = [
  'manifest.json', 'background.js', 'offscreen.html', 'offscreen.js',
  'qr.js', 'i18n.js', 'popup', 'lib', 'icons',
];
const distDir = path.join(root, 'dist');
const zipName = `qr2link-v${version}.zip`;
const zipPath = path.join(distDir, zipName);
const stageDir = path.join(distDir, '.stage', `qr2link-v${version}`);

fs.rmSync(path.join(distDir, '.stage'), { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
for (const item of INCLUDE) {
  fs.cpSync(path.join(root, item), path.join(stageDir, item), { recursive: true });
}

// PowerShell Compress-Archive（Windows 10+ 自带，零依赖）
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' });
fs.rmSync(path.join(distDir, '.stage'), { recursive: true, force: true });

const size = fs.statSync(zipPath).size;
console.log(`done: dist/${zipName} (${(size / 1024).toFixed(1)} KB)`);
