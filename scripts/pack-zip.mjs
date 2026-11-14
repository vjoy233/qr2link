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
  'manifest.json', '_locales', 'background.js', 'offscreen.html', 'offscreen.js',
  'qr.js', 'i18n.js', 'parsers.js', 'safety.js', 'popup', 'lib', 'icons',
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

// .NET ZipArchive 显式建条目（Windows 10+ 自带，零依赖）。
// 不用 Compress-Archive：Windows PowerShell 5.1 的 Compress-Archive 以 '\' 作为条目名
// 分隔符（违反 zip 规范 §4.4.17 要求 '/'）——Chrome Web Store 拒收，unzip/macOS/部分
// 工具解压会破坏 _locales 目录树导致扩展不可用（PR #3 用户报告发现）
const ps = [
  "Add-Type -AssemblyName System.IO.Compression;",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
  `$zipPath = '${zipPath}';`,
  `$stage = '${stageDir}';`,
  `$prefix = 'qr2link-v${version}/';`,
  "if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force };",
  "$fs = [IO.File]::Open($zipPath, 'CreateNew');",
  "$zip = New-Object IO.Compression.ZipArchive($fs, 'Create');",
  "$n = 0;",
  "Get-ChildItem -Recurse -File -LiteralPath $stage | Sort-Object FullName | ForEach-Object {",
  "  $rel = $_.FullName.Substring($stage.Length + 1).Replace('\\', '/');",
  "  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $prefix + $rel, 'Optimal') | Out-Null;",
  "  $n++;",
  "};",
  "$zip.Dispose(); $fs.Close();",
  "Write-Output \"entries: $n\"",
].join('\n');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
fs.rmSync(path.join(distDir, '.stage'), { recursive: true, force: true });

// ---- 打包自检：字节级扫描条目名，任何反斜杠分隔符即失败（防回归） ----
// 读 local file header（PK\x03\x04）与 central directory（PK\x01\x04 处的 0x01 0x02）名段
const buf = fs.readFileSync(zipPath);
const bad = [];
for (let i = 0; i < buf.length - 4; i++) {
  const isLocal = buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04;
  const isCentral = buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02;
  if (!isLocal && !isCentral) continue;
  const nameLen = buf.readUInt16LE(i + (isLocal ? 26 : 28));
  const nameStart = i + (isLocal ? 30 : 46);
  const name = buf.toString('utf8', nameStart, nameStart + nameLen);
  if (name.includes('\\')) bad.push(name);
}
if (bad.length) {
  console.error(`打包失败自检：${bad.length} 个条目名含反斜杠分隔符（示例：${bad[0]}）`);
  process.exit(1);
}

const size = fs.statSync(zipPath).size;
console.log(`done: dist/${zipName} (${(size / 1024).toFixed(1)} KB)，条目分隔符已通过字节级自检`);
