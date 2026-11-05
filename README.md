# QR2Link

把含二维码的图片在**本地**识别成文本或网页链接，并可一键打开的 Chrome / Edge 扩展（Manifest V3，无需构建，零第三方网络上传）。

遇到网页上的登录码、支付码、分享码，不用再掏手机——让浏览器自己「看懂」二维码。

## 功能

### 三个核心入口

| 入口 | 说明 |
|------|------|
| 📷 **网页截图识别** | 截取当前标签页可视区域，可在弹窗内**拖拽框选**二维码区域后识别 |
| 📁 **本地图片上传** | 选择本地图片文件，或直接**拖拽**图片到弹窗 |
| 📋 **剪贴板粘贴识别** | 点「读取剪贴板图片」或直接 **Ctrl+V** 粘贴（如 Win+Shift+S 系统截图） |

### 增强项

- **快捷键直扫**（默认 `Alt+Shift+S`）：截图当前页并识别，命中 http/https 链接时自动打开第一个
- **右键识别**：任意图片右键 →「识别图中二维码」（远程跨域图片属实验性，见下）
- **识别历史**：默认关闭；开启后仅保存你主动点「保留」的文本结果（≤20 条，不存图片）
- **双引擎解码**：原生 BarcodeDetector（可用时支持一图多码）+ jsQR 兜底（反色码支持）；三阶段策略（降采样快扫 → 原图全分辨率重试 → 无结果时象限分块重扫），覆盖大图小码与多码同图场景

## 安装（开发者模式加载）

**方式一：下载 Release 包（推荐普通用户）** —— 到 [Releases](https://github.com/vjoy233/qr2link/releases) 下载 `qr2link-v*.zip` 解压，然后按下面第 2–5 步选择解压出的文件夹。

**方式二：克隆仓库（开发者）** —— 下载 / 克隆本仓库到本地，同法加载仓库根目录。

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择含 `manifest.json` 的目录
4. 工具栏出现 QR2Link 图标即可使用

修改代码后，在扩展管理页点「重新加载」生效。

> 要求 Chrome / Edge 116+（`chrome.runtime.getContexts` 依赖）。不支持 Firefox。

## 快捷键修改

`chrome://extensions/shortcuts`（Edge：`edge://extensions/shortcuts`）→ 找到 QR2Link → 修改「截图并识别当前网页中的二维码」。

## 权限与用途

本扩展遵循权限最小化，**刻意不申请** `<all_urls>`、`host_permissions`、`tabs`。

| 权限 | 用途 |
|------|------|
| `activeTab` | 仅在您主动使用时截取当前标签页画面以识别二维码 |
| `clipboardRead` | 仅读取剪贴板中的图片用于本地二维码识别，不读取/上传文本与其他数据 |
| `clipboardWrite` | 用于您点击复制按钮时写入识别结果 |
| `contextMenus` | 提供右键识别图片二维码入口 |
| `offscreen` | 在后台无界面环境下本地解码图片 |
| `storage` | 仅在您开启后于本机保存主动保留的识别记录 |

## 隐私声明（摘要）

- 图片与二维码内容**全部在本地解码，不上传任何第三方服务**
- 唯一网络例外：右键识别网页上的**远程图片**时，浏览器会向该图片的原始地址发起请求以获取图片字节；跨域图片大概率失败（有意取舍，不为此加宽权限）
- 识别结果**不会自动写入剪贴板**，仅您点击「复制」时写入
- 识别历史仅存于本机 `chrome.storage.local`，默认关闭，开启后只保存主动保留的文本；清除浏览器历史记录**不会**清除它，请使用弹窗内「清空」按钮

完整政策见 [PRIVACY.md](PRIVACY.md)。

## 使用提示

- `chrome://` 设置页、PDF 查看器等特殊页面可能无法截图 → 请改用系统截图后粘贴 / 上传
- 识别非 URL 内容（WiFi 密码、名片等）只展示原文与复制，不会拼接搜索或改写
- `javascript:` / `data:` 等非 http/https 协议内容不会被打开
- 大图中含小二维码时自动进行全分辨率重试；仍失败可框选二维码区域后重试
- **一图多码**：原生 BarcodeDetector 可用的环境（如部分移动端）可一次展示多个结果；Windows 桌面（以 jsQR 解码）对「整体不识别」的多码图会自动**象限分块重扫**（并排 / 堆叠双码、四角均布等常见布局可全部救回）。若图中码较密集或仅解出其中一个，请**框选目标码**识别

## 开发

```
qr2link/
├── manifest.json       # MV3 清单（无构建，仓库根即扩展根）
├── background.js       # Service Worker：快捷键直扫、右键菜单、offscreen 生命周期
├── offscreen.html/.js  # 隐藏解码文档（仅快捷键/右键链路使用）
├── qr.js               # 共享解码模块（双引擎 + 三阶段，popup/offscreen 共用）
├── i18n.js             # UI 文案常量收口（仅中文）
├── popup/              # 弹窗：三入口、框选裁剪组件、结果卡片、历史
├── lib/jsQR.js         # jsQR 1.4.0 官方 dist（vendor 锁版本）
├── icons/              # 图标（icon.svg 为源稿，scripts/gen-icons.mjs 生成 PNG）
└── test/               # 测试页 + 样例二维码（本地生成，无网络依赖）
```

```bash
npm install               # 仅开发/测试依赖（qrcode、sharp 等）
node test/gen-qr.mjs      # 重新生成测试二维码样例
node scripts/gen-icons.mjs# 重新生成图标 PNG
```

浏览器打开 `test/index.html` 即可开始手工验证（截图 / 上传 / 粘贴 / 快捷键 / 右键）。

调试入口：弹窗内右键 → 检查；扩展管理页「service worker」；`chrome://extensions` → 检查视图 offscreen.html。

### 自动化验收（test/e2e）

Playwright 驱动真实浏览器加载未打包扩展跑 68 条验收用例（DESIGN §8 的可自动化子集）：

```bash
cd test/e2e
NODE_PATH="$(npm root -g)" node run-all.cjs msedge   # 主环境 Edge（需本机装有 Playwright 全局包）
NODE_PATH="$(npm root -g)" node run-all.cjs chromium # 交叉验证
```

- 品牌版 Chrome 137+ 已移除 `--load-extension`，自动化请在 Edge / Playwright Chromium 跑；Chrome 手工项见 `TEST-RESULTS.md` §6
- 套件涉及真实 OS 键盘注入（Alt+Shift+S）与系统剪贴板读写，会短暂抢占前台窗口
- 报告输出至 `test/e2e/report/`；首轮验收实测结论见 [TEST-RESULTS.md](TEST-RESULTS.md)

## 设计文档

架构与全部决策记录见 [DESIGN.md](DESIGN.md)。

## 许可证

本项目代码采用 [MIT License](LICENSE)。`lib/jsQR.js` 为 [cozmo/jsQR](https://github.com/cozmo/jsQR) 官方构建产物（Apache-2.0），许可证全文见 [THIRD_PARTY_LICENSES/jsQR-Apache-2.0.txt](THIRD_PARTY_LICENSES/jsQR-Apache-2.0.txt)。
