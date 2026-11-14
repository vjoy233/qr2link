# QR2Link

中文 | [English](README.en.md)

在**本地**识别二维码 / 条码并打开链接，或把文字与链接生成自定义二维码的 Chrome / Edge 扩展（Manifest V3，无需构建，零第三方网络上传）——一个「双向」二维码工具箱。

界面语言自动跟随浏览器：内置简体中文（zh-CN）与英文，其余语言回落英文。

遇到网页上的登录码、支付码、分享码，不用再掏手机——让浏览器自己「看懂」二维码。

## 功能

### 四个核心入口

| 入口 | 说明 |
|------|------|
| 📷 **网页截图识别** | 截取当前标签页可视区域，可在弹窗内**拖拽框选**二维码区域后识别 |
| 📁 **本地图片上传** | 选择本地图片文件，或直接**拖拽**图片到弹窗 |
| 🎥 **摄像头扫码** | 打开摄像头实时扫描，命中即停、一键打开 / 复制 / 继续扫（摄像头使用需浏览器运行时授权，帧数据仅本地内存处理） |
| ⚡ **生成二维码** | 文字 / 链接 → 自定义样式二维码：点阵 × 定位角样式、前景 / 背景色、中央 Logo，PNG 下载 / 复制 |

另有 📋 **剪贴板通道**：点「读取剪贴板图片」或直接 **Ctrl+V** 粘贴（如 Win+Shift+S 系统截图）。

### 识别能力

- **主流二维码与条码**：QR、DataMatrix、Aztec、PDF417，以及常见 1D 条码（EAN-13/UPC-A、Code128、Code39、Code93、ITF、Codabar）——不承诺穷举所有码制
- **解码引擎**：zxing-wasm（随扩展打包的 WebAssembly，**本地执行、零网络**）与原生 BarcodeDetector（可用时）合并识别，空结果时 jsQR 应急兜底；外层三阶段策略（降采样快扫 → 原图全分辨率重试 → 无结果时象限分块重扫），覆盖大图小码与多码同图场景
- **结构化解析**：WIFI:（密码可复制）、otpauth://（TOTP 动态验证码由浏览器 WebCrypto 在本地按 RFC 6238 计算，密钥默认打码）、vCard（可下载 .vcf）、tel: / sms: / mailto: / geo:（语义卡片，仅提供复制）

### 增强项

- **安全预检**：识别出的 http/https 链接在弹窗结果卡片中经**纯本地启发式**分级提示（同形仿冒域名 / 链接内嵌登录信息 / 明文 HTTP / IP 直连 / 短链）；高风险链接「打开」需两段式确认
- **快捷键直扫**（默认 `Alt+Shift+S`）：截图当前页并识别，命中 http/https 链接时自动打开第一个（注意：此路径**不做安全预检**，见使用提示）
- **右键识别**：任意图片右键 →「识别图中二维码」（远程跨域图片属实验性，见下）
- **识别历史**：默认关闭；开启后仅保存你主动点「保留」的文本结果（≤20 条，不存图片）
- **中英双语**：界面（含右键菜单、快捷键说明、商店描述）随浏览器语言自动切换，见 [I18N-PLAN.md](I18N-PLAN.md)

## 已知限制

- zh-TW / zh-HK 浏览器暂无繁体语言包，界面回落英文（简体用户不受影响）；后续按需补充 `_locales/zh_TW`
- 全码制识别为尽力识别：极端破损、密集排布或冷门码制可能漏识别，可框选后重试（见使用提示）
- 摄像头扫码依赖浏览器 `getUserMedia` 运行时授权；权限被拒或无设备时页面会给出引导

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
| `clipboardWrite` | 用于您点击复制按钮时写入识别结果 / 生成的二维码图片 |
| `contextMenus` | 提供右键识别图片二维码入口 |
| `offscreen` | 在后台无界面环境下本地解码图片 |
| `storage` | 仅在您开启后于本机保存主动保留的识别记录 |

两点说明：

- **摄像头不是 manifest 权限**：摄像头扫码走浏览器 `getUserMedia` **运行时授权**（首次使用时浏览器弹窗询问，可随时在地址栏权限图标中撤销），manifest 权限列表零新增。
- **CSP `wasm-unsafe-eval`**：manifest 的 `content_security_policy` 含此项，是让随扩展打包的 WebAssembly 解码引擎（zxing-cpp，本地执行、零网络）得以运行的浏览器要求；Chrome Web Store 政策明确允许打包 wasm。它不是权限，不带来任何额外的数据访问。

## 隐私声明（摘要）

- 图片、摄像头帧与二维码内容**全部在本地解码，不上传任何第三方服务**；识别与生成均不产生网络请求
- 唯一网络例外：右键识别网页上的**远程图片**时，浏览器会向该图片的原始地址发起请求以获取图片字节；跨域图片大概率失败（有意取舍，不为此加宽权限）
- 摄像头帧仅在内存中逐帧解码（不截图、不录像、不落盘），关闭扫码页即停止摄像头
- 识别结果**不会自动写入剪贴板**，仅您点击「复制」时写入
- 识别历史仅存于本机 `chrome.storage.local`，默认关闭，开启后只保存主动保留的文本；清除浏览器历史记录**不会**清除它，请使用弹窗内「清空」按钮

完整政策见 [PRIVACY.md](PRIVACY.md)。

## 使用提示

- `chrome://` 设置页、PDF 查看器等特殊页面可能无法截图 → 请改用系统截图后粘贴 / 上传
- 识别非 URL 内容（WiFi 密码、名片等）只展示原文与复制，不会拼接搜索或改写；tel: / sms: / mailto: / geo: 等语义卡片同样只提供复制，不自动打开
- `javascript:` / `data:` 等非 http/https 协议内容不会被打开
- **快捷键直扫与摄像头扫码的「打开 / 识别后自动打开」不做安全预检**（预检仅在弹窗结果卡片中生效）——这是刻意的行为分层：扫码即开路径保持零确认直达（摄像头「自动打开」为默认关闭的显式 opt-in），风险分级提示请依赖弹窗路径
- 大图中含小二维码时自动进行全分辨率重试；仍失败可框选二维码区域后重试
- **一图多码**：zxing 单趟即支持整图多码；jsQR 应急路径对「整体不识别」的多码图会自动**象限分块重扫**（并排 / 堆叠双码、四角均布等常见布局可全部救回）。若图中码较密集或仅解出其中一个，请**框选目标码**识别
- 摄像头扫码「识别后自动打开」开关默认关闭、仅当次会话有效（不持久化）；页面切至后台或关闭时自动停止摄像头

## 开发

```
qr2link/
├── manifest.json       # MV3 清单（无构建，仓库根即扩展根；CSP 含 wasm-unsafe-eval）
├── _locales/           # chrome.i18n 语言包（en + zh_CN，default_locale=en）
├── background.js       # Service Worker：快捷键直扫、右键菜单、offscreen 生命周期
├── offscreen.html/.js  # 隐藏解码文档（仅快捷键/右键链路使用）
├── qr.js               # 共享解码模块（native→zxing→jsQR 引擎链 + 三阶段策略 + 摄像头帧 decodeFrame）
├── parsers.js          # 结构化解析（WIFI/otpauth/vCard/tel/sms/mailto/geo，纯本地）
├── safety.js           # 链接安全预检（纯本地启发式：同形/userinfo/明文/IP/短链）
├── i18n.js             # UI 文案装载（chrome.i18n → self.I18N，调用方零改动）
├── popup/              # 弹窗：四入口、框选裁剪、结果卡片（解析+预检）、历史、生成视图
├── camera/             # 摄像头扫码标签页（getUserMedia 运行时权限，无新 manifest 权限）
├── lib/                # vendor：jsQR / zxing-reader+wasm / qr-code-styling（SHA256 锁定）
├── THIRD_PARTY_LICENSES/  # 全部第三方组件许可证全文
├── icons/              # 图标（icon.svg 为源稿，scripts/gen-icons.mjs 生成 PNG）
└── test/               # 测试页 + 样例二维码 + e2e（本地生成，无网络依赖）
```

```bash
npm install               # 仅开发/测试依赖（qrcode、sharp 等）
node test/gen-qr.mjs      # 重新生成测试二维码样例
node scripts/gen-icons.mjs# 重新生成图标 PNG
node scripts/vendor-sync.mjs  # vendor 同步 + SHA256 校验（发版门禁）
npm run check:locales     # _locales 完整性校验（key 奇偶/引用闭包/manifest token）
```

浏览器打开 `test/index.html` 即可开始手工验证（截图 / 上传 / 粘贴 / 摄像头 / 快捷键 / 右键）。

调试入口：弹窗内右键 → 检查；扩展管理页「service worker」；`chrome://extensions` → 检查视图 offscreen.html。

### 自动化验收（test/e2e）

Playwright 驱动真实浏览器加载未打包扩展跑 148 条验收用例（DESIGN §8 的可自动化子集），同一套用例支持中英双语回归（断言文案与 `_locales` 同源）：

```bash
cd test/e2e
NODE_PATH="$(npm root -g)" node run-all.cjs msedge                           # 主环境 Edge，中文（需本机装有 Playwright 全局包）
NODE_PATH="$(npm root -g)" node run-all.cjs chromium                         # 交叉验证，中文
QR2LINK_E2E_LANG=en-US NODE_PATH="$(npm root -g)" node run-all.cjs chromium  # 英文回归
```

- 品牌版 Chrome 137+ 已移除 `--load-extension`，自动化请在 Edge / Playwright Chromium 跑；Chrome 手工项见 `TEST-RESULTS.md` §6
- 套件涉及真实 OS 键盘注入（Alt+Shift+S）与系统剪贴板读写，会短暂抢占前台窗口；摄像头用例使用 Chromium fake media 设备（无需真实摄像头），其中「真机等价」用例以 MJPEG 文件作为采集设备内容源（帧 = 真实码图，经完整生产链路零注入命中）
- 报告输出至 `test/e2e/report/`；run-all 前置门禁为 `check-locales` + `vendor-sync`；实测结论见 [TEST-RESULTS.md](TEST-RESULTS.md)

## 设计文档

架构与全部决策记录见 [DESIGN.md](DESIGN.md)；v1.2「双向工具箱」实施方案见 [V1.2-PLAN.md](V1.2-PLAN.md)。

## 许可证

本项目代码采用 [MIT License](LICENSE)。随扩展打包的第三方组件（许可证全文见 [THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/)）：

| 组件 | 用途 | 许可证 |
|------|------|--------|
| [jsQR](https://github.com/cozmo/jsQR) | 二维码应急解码引擎 | Apache-2.0 |
| [zxing-wasm](https://github.com/soxley/zxing-wasm)（wrapper）/ [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp)（引擎） | 全码制 WebAssembly 解码引擎，本地执行 | MIT / Apache-2.0 |
| [qr-code-styling](https://github.com/kozakdenys/qr-code-styling)（内嵌 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)） | 二维码生成与样式渲染 | MIT / MIT |
