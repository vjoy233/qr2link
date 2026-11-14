# QR2Link — 二维码转网页链接 Chrome 插件 · 方案设计文档

> 版本：v1.8（2026-11-14）
> 状态：已评审通过（含外部 review 修订 + grill 自审拷问；v1.2 迭代四 PR 见 V1.2-PLAN.md）
> 项目目录：`D:\Vibing\qr2link`

**变更记录**

| 版本 | 说明 |
|------|------|
| v1.8 | v1.2「双向工具箱」迭代收尾（V1.2-PLAN.md，4 个串行 PR 全部合并；grill 拍板 8 项 + 外部 review + PR #4/#5/#6 AIbot review 处置见 V1.2-PLAN 文末）：① **引擎升级**（PR-1/#4）——引入 zxing-wasm@3.1.6（WebAssembly 本地执行，`locateFile` 重写为 `chrome.runtime.getURL` 杜绝 CDN，CSP 加 `wasm-unsafe-eval`），引擎链变更为 **native+zxing 合并 → jsQR 空结果兜底**，阶段 2 按性能基准分档（≤20MP zxing / 20–50MP 维持 v1.1 行为），全码制（QR/1D/DataMatrix/Aztec/PDF417，拍板⑧），vendor 三文件 SHA256 门禁（`scripts/vendor-sync.mjs`）；② **结构化解析 + 安全预检**（PR-2/#5）——`parsers.js`（WIFI/otpauth TOTP 本地动态码/vCard/tel/sms/mailto/geo，拍板①）与 `safety.js`（纯本地启发式三级分级，danger 两段式确认拍板⑦；快捷键直扫不预检拍板③）；③ **生成视图**（PR-3/#6）——`popup/generate.js` 弹窗内嵌（拍板⑥），qr-code-styling@1.9.2，点阵×定位角×颜色×logo，UTF-8 预编码 + 容量前置闸，草稿存 storage.session；④ **摄像头扫码**（PR-4）——独立标签页 `camera/`（getUserMedia 运行时权限，manifest 零新增），`qr.js` 新增 `decodeFrame` 单趟帧接缝，rVFC + in-flight 丢帧锁 + 150ms 节流，自动打开开关默认关仅会话内有效；⑤ 收尾——版本 1.2.0、pack-zip 加 `camera`、README/PRIVACY ×2 重写（快捷键不预检边界句、CSP 说明、摄像头/wasm/生成本地口径）、旧引擎口径清理、e2e 至 **141 用例**（A–I 九组，msedge/chromium × zh-CN/en-US 四轮全绿） |
| v1.7 | 中英双语适配（I18N-PLAN.md，D1–D4 + grill Q1–Q6 全部拍板）：① 接入 chrome.i18n——新增 `_locales/{en,zh_CN}`（42 key），`i18n.js` 改为 getMessage 装配（对外 `self.I18N` 接口与 key 零变化，兑现 v1.2「文案收口」承诺）；manifest `description`/快捷键描述走 `__MSG_`，`default_locale=en`（未知语言回落英文，D1）；名称保持 QR2Link 不翻译（D2）。② `<html lang>` 按 `locale_lang` 自描述 key 设定（比 getUILanguage 更准，可识别 default 回落）；右键菜单补 `onStartup` 重建（浏览器改语言重启后标题跟随）。③ 守门与发布：`pack-zip` INCLUDE 补 `_locales`（漏装=扩展损坏）；新增 `scripts/check-locales.mjs` 静态校验（key 奇偶/非空/引用闭包/manifest token），run-all 第 0 步强制执行 + 发版清单（Q3，不建 CI）。④ e2e 双语化：`--lang` 启动参数 + `msg()` 期望文案助手（与 `_locales` 同源），21 处硬编码中文断言去硬编码；新增 A3b（manifest 解析）/B1 扩展（html lang）；同一套 69 用例 `QR2LINK_E2E_LANG={zh-CN,en-US}` 双语回归（Q4：en 仅 chromium）。⑤ 文档：README/PRIVACY 英文版独立文件 + 互链（D4）；zh-TW/HK 无繁体包回落英文（Q2 拍板接受，README 已知限制 + issue 待办）。⑥ 版本 1.0.0→1.1.0（Q6）。⑦ 真实弹窗实测（computer use 全链路）发现两处发布级缺陷并修复：发布 zip 条目分隔符 `\`→`/`（Compress-Archive 缺陷，CR store 拒收 + 严格解压工具破坏 `_locales`，pack-zip 内置字节级自检）；`#drop-overlay` 常驻可见（`display:flex` 压过 `hidden` 属性，v1.0 起即存在，补 `[hidden]{display:none}` + B1 回归断言） |
| v1.6 | PR #2 外部 review 采纳合入：① 重扫墙钟预算——自阶段 2 起算 8s，阶段 3 梯子逐 tile 检查、超时截停（像素预算只限扫描量、无法跨设备换算耗时上界，单机实测不构成证明；review P1。注：review 中「24 tile × 9MP ≈ 216MP/864MB」的算术有误，每趟网格累计处理量 ≈ rect 面积，全梯子 ≈ 4×rect（9MP 时约 36MP），但其「最坏情形须有界」的结论成立，仍采纳）；② 新增 `QR2Link.getLastDecodeStats()` 测试探针（阶段选择记录，E2E 边界用例锁定 9MP/50MP 阈值，review P2）；③ 补堆叠双码（1×2 梯级）可重复 E2E 断言与 offscreen 最坏全 miss 回归用例（review P2）；④ TEST-RESULTS 顶部口径重构为「当前迭代唯一总览」（review P2） |
| v1.0 | 初版设计 |
| v1.1 | 合入外部 review：补齐 Manifest 权限（offscreen/storage/commands/clipboardWrite）、BarcodeDetector 改运行时能力检测、多码承诺降调、两阶段解码替代固定降采样、隐私声明修正、历史默认关闭、截图新增框选裁剪、测试矩阵扩充 |
| v1.2 | grill 自审拷问合入：目标浏览器 Chrome+Edge（Firefox 排除）、按可上架标准准备、手动复制、popup 动态加宽、命名 QR2Link、UI 仅中文文案收口；补充 4 条工程默认值与 Edge 实测矩阵 |
| v1.3 | 首轮自动化验收（TEST-RESULTS.md）后修订：右键链路远程取图增加 10s 超时（黑洞网络下 fetch 永不返回导致用户无限等待，验收发现，用户确认修复） |
| v1.4 | 外部代码 review 采纳合入（用户确认）：① offscreen 创建锁失败释放；② offscreen 消息链 15s 超时（>10s 取图超时防误杀）；③ 阶段 2 全图重扫增加 50MP 像素预算与 canvas 单边防护；④ 截图/剪贴板入口捕获期互斥；⑤ 复制失败按钮反馈；⑥ badge 清除定时器去重。另补 jsQR Apache-2.0 许可证文本（THIRD_PARTY_LICENSES/）。不采纳项：DOM_SCRAPING reason 变更、badge 背景色还原（理由见 review 回应） |
| v1.5 | issue #1 多码图支持：解码管线新增**阶段 3 象限分块重扫**（无结果时按 1×2 / 2×1 / 2×2 / 4×4 梯子逐块重跑引擎序列再合并去重），救回 jsQR 对多码图的「整体 miss」。Windows 桌面（无 BarcodeDetector）下双码/四角四码/堆叠双码实测全部救回；仅在阶段 2 实际执行过（≤50MP）时进入，超预算大图维持「框选重试」契约不变（B33）。已知边界：jsQR 全图已解出 ≥1 码时不分块（无法廉价区分「仅此一码」与「多码漏网其一」）；极端布局（3 列均布、密集骑缝码）仍可能 miss → 框选重试 |

**产品要素（已定）**

| 项 | 决策 |
|---|---|
| 名称 | **QR2Link**（manifest `name` 纯英文不翻译，`description` 经 `__MSG_` 双语） |
| UI 语言 | **中英双语（chrome.i18n）**：`_locales/{en,zh_CN}`，`default_locale=en` 未知语言回落英文；文案经 `i18n.js` 装配收口（v1.7） |
| 目标浏览器 | **Chrome + Edge**（单套 Chromium MV3 代码；Edge 逐项实测。Firefox 明确排除——其无 offscreen API，避免双后台架构） |
| 分发方式 | **按可上架标准准备**：图标、PRIVACY.md、权限用途声明一步到位；暂不提交审核 / 不注册开发者账号，上架时补公网隐私政策 URL 即可 |

---

## 1. 背景与目标

在浏览器里遇到二维码（网页上的登录码、支付码、分享码等）时，用户往往需要掏手机扫描。本插件让浏览器自己「看懂」二维码，并进一步成为**双向工具箱**：

把**任何含二维码 / 条码的图片**在本地识别成文本 / 网页链接（可一键打开），或把文字 / 链接**生成**自定义样式的二维码。

四个核心入口（v1.2 起）：

| # | 功能 | 说明 |
|---|------|------|
| 1 | **网页截图识别** | 截取当前网页可视区域，**可框选裁剪二维码区域**后识别 |
| 2 | **本地图片上传识别** | 上传 / 拖拽本地图片文件，识别其中的二维码 |
| 3 | **摄像头扫码** | 独立标签页实时扫描（v1.2 新增，§5.6；getUserMedia 运行时权限） |
| 4 | **生成二维码** | 文字 / 链接 → 自定义样式二维码，PNG 下载 / 复制（v1.2 新增，§4.5） |

另有剪贴板通道（读取剪贴板图片 / Ctrl+V 粘贴）。

附加功能（见 §5）：快捷键直扫、右键图片识别、识别历史（默认关闭）、结构化解析（§5.4）、链接安全预检（§5.5）。

**设计原则**

- 不重复造轮子：解码复用成熟方案（zxing-wasm WebAssembly + 原生 BarcodeDetector + jsQR 应急，§2.1）
- 隐私优先：识别 / 生成 / 摄像头帧全部只在本地处理、不上传第三方服务（完整声明见 §1.1）
- 权限最小化：不引入 `<all_urls>` / `tabs` / `host_permissions`；摄像头走运行时权限不进 manifest

**产品范围边界（明确不支持）**

- 截图为**当前标签页可视区域**，不支持整页长截图、不自动滚动
- 不截取浏览器外部内容（屏幕/窗口级截图属 `chrome.desktopCapture`，超出本版范围）
- 摄像头扫码为**标签页实时扫描**，不做浏览器外部内容扫描 / Side Panel（V1.2-PLAN 明确不做 B2/B3）
- 不支持 Firefox（见产品要素表）

### 1.1 隐私声明（准确版）

> 图片与二维码内容**全部在本地解码，不上传任何第三方服务**；解码引擎（含 WebAssembly 版 zxing）全部随扩展打包、本地执行，运行时不下载任何代码。
> 例外：右键识别网页上的远程图片时，浏览器会**向该图片的原始地址**发起请求以获取图片字节；能否成功取决于该图片的跨域与访问限制（见 §5.2）。
> 摄像头帧仅内存逐帧解码，不截图、不录像、不落盘（§5.6）；生成完全本地（§4.5）。
> 识别历史仅存于本机 `chrome.storage.local`，**默认关闭**，开启后只保存用户主动保留的文本结果，不保存图片（见 §5.3）。
> 识别结果**不会自动写入剪贴板**，仅用户点击「复制」时写入（见 §4.4）。

---

## 2. 技术调研结论

### 2.1 二维码解码 —— 三段引擎链（v1.2 起）

| 方案 | 评估 | 结论 |
|------|------|------|
| **zxing-wasm@3.1.6**（zxing-cpp 编译为 WebAssembly，MIT/Apache-2.0） | 随扩展打包（946KB wasm + IIFE wrapper），`readBarcodes(imageData, opts)` 原生多码 + **全码制**（QR + 常见 1D + DataMatrix/Aztec/PDF417）；`textMode:'Plain'` 保证 1D 原文不被 HRI 改写。**关键坑**：发行版默认 `locateFile` 指向 jsDelivr CDN——违反零网络承诺 + CWS 远程代码政策，必须 `prepareZXingModule` 重写为 `chrome.runtime.getURL('lib/zxing_reader.wasm')` | ✅ **主引擎**（全码制 + 多码）；wasm 懒加载，初始化失败永久降级 jsQR（拍板④） |
| **BarcodeDetector API**（浏览器原生） | 可选的原生加速引擎：接口与支持格式平台相关，须运行时检测；支持时一次 `detect()` 可能返回多个二维码。**仅 QR**——native 命中后不短路 zxing（PR #4 review P1：短路会漏同图 1D/DataMatrix 码），两者合并去重 | ✅ 检测通过时与 zxing 合并使用 |
| **jsQR**（cozmo/jsQR，4k★，Apache-2.0） | 纯 JS，跨平台行为一致，`inversionAttempts:'attemptBoth'` 支持反色码 | ✅ **应急兜底**（zxing 初始化失败/运行期异常时接管；静态图各阶段空结果时按分档接力，拍板④） |
| html5-qrcode 等 UI 框架 | 摄像头 UI 框架过重，自建 `camera/` 更可控 | ❌ 不采用 |

**引擎链（按阶段分档，详见 §3.3；性能基准实测定档见 V1.2-PLAN「zxing 性能基准」）**：

- 阶段 1（≤2000px 快扫）：native + zxing **合并**（不短路），仍无命中时 jsQR 兜底——兜「zxing 健康但漏识别」回归面
- 阶段 2（全分辨率）：rect ≤ 20MP 走 native + zxing 合并（jsQR 仅 zxingBroken 时参与）；20–50MP 维持 native → 空时 jsQR（v1.1 行为零变化）
- 阶段 3（象限梯子）：native → jsQR 原样（issue #1 的 jsQR 多码救回机制；zxing 多码在阶段 1/2 已覆盖）
- 摄像头帧（`decodeFrame`）：单趟 native + zxing 合并 → 空结果 jsQR（无三阶段/预算/墙钟，帧 ≤1080p 小图）

**能力检测（运行时，不用版本号判断）：**

```js
async function canUseNativeQr() {
  if (!('BarcodeDetector' in globalThis)) return false;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code');
  } catch { return false; }
}
```

原生引擎的构造与 `detect()` 全程包裹 try/catch，任何异常静默降级，不影响功能；zxing 初始化 / 单趟运行异常 → `zxingBroken` 永久置位降级 jsQR（同构哲学）。

**多码能力承诺（v1.8 起）**：

> zxing 单趟即原生多码（`maxNumberOfSymbols: 8`），与 native 命中合并去重——常见均布布局（并排/堆叠双码、四角四码）跨引擎一致返回多个结果。jsQR 应急路径（zxing 损坏时）对**无结果**的多码图自动进入**阶段 3 象限分块重扫**（§3.3）；已解出 ≥1 码时不分块（无法廉价判断是否存在漏网码），极端布局仍可能 miss → 「框选重试」兜底。已知边界：>20MP 图上的混合码（QR+1D）在 native 命中 QR 时 1D 可能漏（该档刻意不走 zxing 控耗时，已接受）。

### 2.2 网页截图 —— `chrome.tabs.captureVisibleTab` + `activeTab`

- 点击插件图标（popup）、快捷键、扩展右键菜单均可授予 `activeTab` 临时权限，随后即可调用 `captureVisibleTab()`，无需 `<all_urls>`
- **特殊页面（chrome://、PDF 查看器、Web Store、其他扩展页）的可截性以 `captureVisibleTab()` 实际返回为准**，不同页面 / 版本行为可能不同；失败时提示用户改用系统截图 → 粘贴/上传。逐项实测见 §8

### 2.3 剪贴板 —— `clipboardRead` 权限 + 双通道

1. **主动读**：popup 聚焦时 `navigator.clipboard.read()`，先枚举 `ClipboardItem.types`，命中 `image/*` 再 `getType()` 按需读取 Blob
2. **被动读**：popup 内监听 `paste` 事件读取 `clipboardData.items`（Ctrl+V 习惯用户）

交互原则：**只在用户点击「读取剪贴板」按钮或按 Ctrl+V 时读取**，不做定时轮询、不在 popup 获得焦点时隐式读取、只接受 `image/*`、读完即释放 Blob 引用。Ctrl+V 依赖 popup 实际持有焦点，行为列入实测项。

### 2.4 成熟项目交叉验证

- [serkonda7/image-qr-scanner-extension](https://github.com/serkonda7/image-qr-scanner-extension)：TS + jsQR 打包进 MV3，验证 jsQR 路线可行
- [mubaidr/QR-Code-Extension](https://github.com/mubaidr/QR-Code-Extension)（Web Store 数十万用户）：核心流程正是「activeTab 截图 → 解码」，验证截图路线可行

---

## 3. 总体架构

**Manifest V3 + 原生 JS（无构建步骤）+ jsQR 官方 dist 直接引入。**

### 3.1 文件结构

```
qr2link/
├── manifest.json          # MV3 清单（default_locale=en，描述走 __MSG_；CSP 含 wasm-unsafe-eval）
├── _locales/              # chrome.i18n 语言包（en + zh_CN，119 key；check-locales 守门）
├── background.js          # Service Worker：快捷键直扫、右键菜单、offscreen 生命周期
├── offscreen.html/.js     # Offscreen 文档：为 SW 提供 canvas 解码环境（仅快捷键/右键链路使用）
├── qr.js                  # 共享解码模块（popup / offscreen / camera 共用；decodeImage + decodeFrame）
├── parsers.js             # 结构化解析（WIFI/otpauth/vCard/tel/sms/mailto/geo，纯本地）
├── safety.js              # 链接安全预检（纯本地启发式，§5.5）
├── i18n.js                # UI 文案装载（chrome.i18n → self.I18N，调用方零改动）
├── popup/
│   ├── popup.html/.css/.js  # 主 UI（四入口 + 结果卡片 + 历史）
│   ├── crop.js            # 截图预览 + 框选裁剪组件（共享给上传/粘贴的失败重试）
│   └── generate.js        # 生成视图组件（window.Generate，弹窗单宿主，§4.5）
├── camera/
│   └── camera.html/.css/.js  # 摄像头扫码标签页（§5.6；getUserMedia 运行时权限）
├── lib/
│   ├── jsQR.js            # jsQR@1.4.0 官方 dist（vendor，锁版本）
│   ├── zxing-reader.js    # zxing-wasm@3.1.6 IIFE wrapper（主引擎）
│   ├── zxing_reader.wasm  # zxing-cpp 编译产物（946KB）
│   └── qr-code-styling.js # qr-code-styling@1.9.2 UMD（生成视图；内嵌 qrcode-generator）
├── THIRD_PARTY_LICENSES/  # 全部第三方组件许可证全文（5 项）
├── scripts/
│   ├── vendor-sync.mjs    # vendor 同步 + 全文件 SHA256 门禁（run-all 前置 + 发版清单）
│   ├── check-locales.mjs  # _locales 完整性静态校验（含 --self-test 变异测试）
│   ├── gen-icons.mjs      # 图标生成
│   └── pack-zip.mjs       # 发布 zip 打包（含条目分隔符字节级自检）
├── icons/                 # 16 / 48 / 128 PNG
├── test/                  # 本地测试页 + 样例二维码 + e2e（全部本地生成，不依赖网络）
├── PRIVACY.md / PRIVACY.en.md
├── README.md / README.en.md
├── DESIGN.md / I18N-PLAN.md / V1.2-PLAN.md / TEST-RESULTS.md
└── .gitignore             # dist/、test/out/、node_modules、lockfile（刻意不入库）均忽略
```

**职责划分**：静态图入口（截图/上传/粘贴）**全部在 popup 内直接解码**，不经过 SW；`background.js + offscreen` 仅服务「popup 关闭后仍要执行」的场景（快捷键直扫、右键识别）；摄像头扫码为独立标签页（`camera/`），帧解码直接调用 `qr.js` 的 `decodeFrame`。

### 3.2 Manifest（现行完整声明，v1.2 起）

```json
{
  "manifest_version": 3,
  "name": "QR2Link",
  "version": "1.2.0",
  "default_locale": "en",
  "description": "__MSG_manifest_description__",
  "minimum_chrome_version": "116",
  "action": { "default_popup": "popup/popup.html", "default_title": "QR2Link" },
  "background": { "service_worker": "background.js" },
  "permissions": [
    "activeTab", "clipboardRead", "clipboardWrite",
    "contextMenus", "offscreen", "storage"
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "commands": { "scan-current-page": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "__MSG_command_scan_description__" } }
}
```

- **权限列表自 v1.0 起零新增**：摄像头扫码走 `getUserMedia` 运行时权限（浏览器弹窗、可撤销），不进 manifest（v1.2 唯一安全面变化是 CSP 加 `wasm-unsafe-eval`——MV3 Chrome 103+ WebAssembly 需显式 CSP，CWS 政策明确允许打包 wasm）

| 权限 | 用途 | 安装提示 | 商店权限用途声明（上架准备物） |
|------|------|----------|------------------------------|
| `activeTab` | 用户点击/快捷键/右键时临时授权截图与访问当前页 | 无 | 「仅在您主动使用时截取当前标签页画面以识别二维码」 |
| `clipboardRead` | popup 读剪贴板图片 | 「读取你复制和粘贴的数据」 | 「仅读取剪贴板中的图片用于本地二维码识别，不读取/上传文本与其他数据」 |
| `clipboardWrite` | 复制识别结果（无手势边角场景兜底） | 无 | 「用于您点击复制按钮时写入识别结果」 |
| `contextMenus` | 右键图片识别 | 无 | 「提供右键识别图片二维码入口」 |
| `offscreen` | SW 链路的隐藏解码文档 | 无 | 「在后台无界面环境下本地解码图片」 |
| `storage` | 识别历史（默认关闭，开启后仅存文本） | 无 | 「仅在您开启后于本机保存主动保留的识别记录」 |

> `minimum_chrome_version: 116`：`chrome.runtime.getContexts()`（offscreen 文档存在性检查）要求 116+。Edge 同源 Chromium，版本同步，无额外门槛。
>
> 刻意不申请：`<all_urls>` / `host_permissions` / `tabs`。

### 3.3 解码管线（qr.js，纯本地，三阶段 + 帧单趟）

```
图片源(dataURL / Blob / URL)  → decodeImage(source, opts)
  → createImageBitmap(file, {imageOrientation:'from-image'})  ← 修正 EXIF 方向；失败回退 <img>
  ┌─ 阶段1（快速）：最长边 > 2000px 时等比降采样 → ImageData
  │    → ① canUseNativeQr() 通过 → BarcodeDetector({formats:['qr_code']}).detect()（仅 QR）
  │    → ② zxing readBarcodes（全码制、多码）——与 native 命中【合并】不短路（PR #4 review P1）
  │    → ③ 仍无命中 → jsQR(..., {inversionAttempts:'attemptBoth'}) 兜底
  ├─ 阶段2（无结果时重试）：原图全分辨率
  │    （覆盖「大图中的小二维码」：如 8000px 图中 120px 的码，全分辨率下保持原尺寸可识别）
  │    像素预算 ≤50MP；超出跳过（避免内存暴涨），落「框选重试」
  │    rect ≤20MP：native + zxing 合并（jsQR 仅 zxingBroken 时兜）——性能基准定档（V1.2-PLAN）
  │    rect 20–50MP：native → 空时 jsQR（v1.1 行为零变化）
  │    ‖ 重扫墙钟预算自此起算（8s，v1.6）：阶段 2 单趟不可中断（上界即像素预算），
  │    预算用于阻止阶段 3 在其上叠加——慢设备上截停梯子尾部投机趟次
  └─ 阶段3（仍无结果时，issue #1 多码分块）：仅阶段 2 实际执行过才进入
       按几何梯子 1×2 / 2×1 / 2×2 / 4×4 逐块跑 native → jsQR 序列，全部扫完合并
       rect ≤9MP（4K 截图级）逐块全分辨率；更大图按阶段 1 档位（≤2000px）分块
       逐 tile 检查墙钟预算，超时截停剩余趟次（已扫部分照常合并返回）

摄像头帧（camera.js，§5.6）→ decodeFrame(imageData)：单趟 ①native + ②zxing 合并
  → ③空结果 jsQR；无三阶段/像素预算/墙钟（帧 ≤1080p 小图，静态图策略不适用）；
  不写 lastDecodeStats 探针（帧循环高频，保护 decodeImage 诊断契约）

  → 文本去重 → [{ text, isUrl, engine, format }]（format 为 zxing canonical 码制名）
  → 释放 ImageBitmap（.close()）、canvas 与 Blob 引用
```

- 阶段 3 救「多码分布均匀」场景：jsQR 单码引擎对多码图定位点跨码误配会**整体 miss**，分块后单块内通常至多一码即可命中（实测并排双码 / 堆叠双码 / 四角四码全部救回）；最坏全 miss 的耗时上界由**重扫墙钟预算 8s** 保证（v1.6，外部 review #2：像素预算只限扫描量、单机实测不构成跨设备上界证明），不给 offscreen 消息链 15s 超时添险；每趟网格累计处理量 ≈ rect 面积（全梯子 ≈ 4×rect，9MP 时约 36MP，非 24×rect）
- 已知边界（有意取舍）：jsQR 全图已解出 ≥1 码时不分块；极端布局（3 列均布网格、密集骑缝码）仍可能 miss——两者均落「框选重试」兜底，不为多码申请额外权限或引入区域分割预处理
- 图片格式能力**依赖 Chrome/Edge 图像解码器，以实测为准**（png/jpg/webp/bmp/gif 首帧）；扩展名与真实 MIME 可能不符，一律按解码结果处理
- 框选裁剪（§4.1）与三阶段解码互补：用户圈定区域后通常阶段 1 即命中

---

## 4. 核心功能流程设计

### 4.0 Popup 主界面（点击图标打开，动态宽度）

popup 宽度**随状态自适应**（Chrome popup 尺寸上限 800×600）：

- **紧凑态（默认 ~400px）**：四入口 2×2 网格（📷📁🎥⚡，v1.2 定稿）+ 历史
- **展开态（~760px）**：进入截图框选 / 图片预览 / 结果 / 生成视图时加宽，保证大截图缩放预览后仍有画框精度

```
┌─────────────────────────────┐
│  QR2Link  二维码 → 链接      │
│ ┌─────────┐ ┌─────────┐    │
│ │ 📷 截取  │ │ 📁 上传  │    │
│ │ 当前网页 │ │ 图片     │    │
│ └─────────┘ └─────────┘    │
│ ┌─────────┐ ┌─────────┐    │
│ │ 🎥 摄像头 │ │ ⚡ 生成   │    │
│ │ 扫码     │ │ 二维码   │    │
│ └─────────┘ └─────────┘    │
│ [ 📋 读取剪贴板 / Ctrl+V ]  │
│  （整个窗口支持拖拽图片文件） │
├─────────────────────────────┤
│ 预览+框选区（截图后出现）     │
│ [全图识别] [识别所选区域]     │
├─────────────────────────────┤
│ [识别中… / 错误提示]         │
│ ┌─────────────────────────┐ │
│ │ 缩略图  https://…       │ │
│ │  [结构化卡片 §5.4]       │ │
│ │  [安全指示条 §5.5]       │ │
│ │         [打开] [复制]    │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ 最近识别 [开关] [清空]       │
└─────────────────────────────┘
```

### 4.1 网页截图识别（含框选裁剪）

1. 点击「截取当前网页」→ `chrome.tabs.captureVisibleTab()` 得 PNG dataURL
2. 进入**预览 + 框选**视图（popup 随即加宽）：显示截图，用户可拖拽绘制矩形框选二维码区域（可选；默认全图）
   - 「识别所选区域」：canvas `drawImage` 裁剪选区 → 解码管线
   - 「全图识别」：直接整图 → 解码管线
3. 失败（特殊页面不可截 / 无码）→ 提示「用系统截图工具截屏后粘贴，或上传图片」；无码失败时提供「框选重试」入口（共享框选组件）

框选组件（`popup/crop.js`）：`<img>` 预览 + 覆盖层选区（pointer 事件拖拽/调整），返回 `{x,y,w,h}`（换算原图坐标）。同时服务上传/粘贴的失败重试。

### 4.2 本地图片上传

1. `<input type="file" accept="image/*">` 或拖拽文件到 popup → **立即解码**（快路径）
2. 无结果 → 显示预览 + 「框选重试」（共享框选组件）
3. 资源释放：解码完成后关闭 ImageBitmap、清空 FileReader/Blob 引用；超大图注意内存占用

### 4.3 剪贴板粘贴

1. **按钮主动读**：`navigator.clipboard.read()` → 枚举 `types` 找 `image/*` → `getType()` → Blob → 立即解码
2. **Ctrl+V 被动读**：popup `paste` 事件 → `clipboardData.items` → `getAsFile()` → 立即解码
3. 剪贴板无图片（纯文本 / 含文本+HTML 无图片）→ 提示「剪贴板中没有图片」；无结果 → 框选重试
4. 读取失败（焦点丢失等）→ 提示手动 Ctrl+V

### 4.4 结果处理与安全

```js
function parseHttpUrl(raw) {
  const value = raw.trim();
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch { return null; }
}
```

- 结果为合法 http/https 链接 → 卡片提供「打开」（`chrome.tabs.create` 新前台标签页）与「复制」
- **不自动写入剪贴板**：仅用户点击「复制」按钮时 `writeText`（已定决策）
- 非 URL（WiFi 密码、名片等）或非白名单协议（`javascript:` `data:` `file:` `chrome:` `extension:` 等）→ **仅展示原始文本 + 复制**，不拼接搜索、不静默改写
- **渲染一律 `textContent`**，二维码内容绝不拼入 innerHTML
- popup 内打开链接由用户点击触发；唯一自动打开路径是快捷键直扫（§5.1，快捷键本身即用户显式手势）与摄像头扫码页用户开启的「自动打开」开关（§5.6，默认关）
- URL 前后空白 `trim()` 后展示原始文本
- v1.2 起，结果卡片在原文之下追加**结构化解析卡片**（§5.4，命中才追加）与**安全指示条**（§5.5，仅 http/https）

### 4.5 生成二维码视图（v1.2 新增，D1 输入 + D2 样式）

宿主与组件：**弹窗单宿主**（拍板⑥）——`popup/generate.js` 渲染于 popup.html 固定节点 `#generate-root`，全局组件模式（仿 crop.js，`window.Generate`）；popup.js 进入 generate 视图时调用 `Generate.open()`（幂等）。无独立 generate.html、无右键选中文本入口（拍板②）。

- **输入与预填**：textarea；popup 打开即有 activeTab，`chrome.tabs.query` 读当前标签页 URL 预填（无需 tabs 权限）；`chrome://` 等特殊页 / 无 URL → 预填为空 + 占位提示；**草稿优先于预填**（用户输入不被覆盖）
- **草稿持久化**：输入内容存 `chrome.storage.session`（key `qr2link.generate.draft`），每次 input 即时写盘——popup 随时失焦关闭不丢草稿；预填内容不落草稿
- **预览**：`QRCodeStyling` canvas 实时渲染（280px）；**UTF-8 预编码**（PR #6 review P1：内嵌 qrcode-generator 默认 stringToBytes 逐 code unit 截断中文/emoji，先 TextEncoder 编码再逐字节映射 Latin-1 传入）；**容量前置闸**（按模式估算 bit 数，v40-M 边界 2331 UTF-8 字节 / 5596 数字实测锚定——MB 级粘贴即时提示不冻结主线程），库内抛错为第二道防线
- **D2 样式**：5 种点阵（square/rounded/dots/classy/classy-rounded）× 3 种定位角（square/dot/extra-rounded）× 前景/背景色 × logo（file → dataURL；仅栅格白名单——SVG 可携带外部引用违背零网络契约；≤2MB 且解码后 ≤1000px；选择序号竞态防护）
- **动作**：下载 PNG（`download()` data-URI anchor，异步失败有反馈）；复制图片（`getRawData('png')` → `ClipboardItem.write`，失败走 copyFailed）
- **命名口径**：点阵/定位角选项文案用 canonical ASCII 名（与结果 meta 码制名同口径），不进 i18n

---

## 5. 附加功能（随首版交付）

### 5.1 快捷键直扫（Alt+Shift+S，可在 chrome://extensions/shortcuts 修改）

快捷键授予 activeTab → `background.js` 直接 `captureVisibleTab()` → 发送 offscreen 解码 →
- 识别出 http/https 链接 → **自动打开新前台标签页**；**多个链接时只自动打开第一个**（已定默认值，不连环开页）
- 非 URL 文本 / 无结果 / 截图失败 → 图标 badge 显示 `✕` 3 秒（无结果时不打扰）

### 5.2 右键图片识别（标注：远程图片属实验性）

右键任意图片 →「识别图中二维码」→ offscreen 内 `fetch(srcUrl)` 取图 → 解码 → 打开链接 / badge 反馈。

- activeTab 临时权限覆盖**当前页面源**：同源图片可取；**跨域 CDN 图片大概率失败**（不申请 `<all_urls>` 的有意取舍）
- **远程取图 10s 超时**（AbortController）：超时 / 网络失败 / 非 2xx 统一按「取图失败」降级，避免黑洞网络下用户无限等待（v1.3，验收后补）
- 失败时 badge `✕` + 提示改用「截图 / 下载后上传」
- 隐私注意：`fetch(srcUrl)` 会向图片原始地址发起请求（见 §1.1）

### 5.3 识别历史（默认关闭）

- 开关在 popup「最近识别」区，默认 **关闭**；`chrome.storage.local` 仅存**用户主动保留的文本结果**（点击结果卡片「保留」），不存图片、不自动记录
- 存储内容可能含登录地址 / 邀请链接 / 授权码等敏感信息 → README/PRIVACY 明示：清除浏览记录**不会**清除该存储，提供一键「清空历史」
- 历史条目可打开（URL）/ 复制 / 删除；otpauth:// 的 `secret=` 显示层打码（存储/复制保持原文，PR #5 review P1）

### 5.4 结构化解析（v1.2 新增，C1；`parsers.js`，全局 `window.Parsers.parse(text)`）

识别结果为结构化 payload 时，结果卡片原文下追加对应语义卡片（渲染全 `textContent`；解析失败返回 null 回落纯文本卡片——锁定契约）：

| 格式 | 卡片能力 |
|------|----------|
| `WIFI:`（规范转义 `\; \, \: \\`） | SSID / 加密方式 / 密码（复制）/ 隐藏标志 |
| `otpauth://totp` | **TOTP 动态验证码本地生成**（拍板①）：内嵌 Base32 解码 + WebCrypto HMAC 按 RFC 6238，实时刷新 + 倒计时 + 一键复制；secret 默认打码点击显示；正确性以 RFC 官方测试向量锁定 |
| `otpauth://hotp` | 仅展示参数（不生成） |
| vCard（`BEGIN:VCARD`） | FN/TEL/EMAIL/ORG/TITLE + 下载 `.vcf`（data-URI anchor） |
| `tel:` / `sms:` / `smsto:` / `mailto:` / `geo:` | 语义卡片，**仅提供复制**（与「仅 http/https 可打开」一致） |

全部解析防御性：长度上限、字段数上限、失败返回 null。TOTP 倒计时 `setInterval` 随视图切换清理（popup.js totpTimers）。

### 5.5 链接安全预检（v1.2 新增，C2；`safety.js`，全局 `window.Safety.assessUrl(url)`）

纯本地启发式、零网络，输出 `{level, reasons}`（枚举 key → i18n，reasons 按 danger 先于 caution、规则枚举序稳定输出——测试锁定排序）：

- **danger**：`xn--` punycode 解码后混排拉丁/西里尔/希腊字母（同形攻击，内嵌 RFC 3492 解码器）；URL 带 userinfo（`user[:pass]@`，含仅用户名形态——覆盖 `https://example.com@evil.com/` 类仿冒）
- **caution**：`http:` 明文；IP 字面量主机（含 IPv6 `[::1]`、IPv4-mapped、私网/回环段，统一归「内网或本机地址」）；已知短链/QR 短链域（~15 个，safety.js 顶部常量）

**作用域（拍板③/⑦）**：预检仅在**弹窗结果卡片**路径生效——isUrl 卡片加绿/黄/红指示条（可展开原因列表）；**danger 级「打开」变两段式确认**（复用 history-clear 的 3s 解除模式；caution/ok 一键直开）。`background.js` 的 `openFirstLink` **不接入** safety、快捷键直扫行为零变化（直扫路径用户没看过 URL，保持零确认直达；README 使用提示明示此边界——「快捷键直扫自动打开不做安全预检」）。

### 5.6 摄像头扫码（v1.2 新增，B1；`camera/camera.html + camera.js + camera.css`）

**宿主**：popup「摄像头扫码」入口 `chrome.tabs.create` 打开的普通标签页（home 网格 2×2 定稿 📷📁🎥⚡）；**getUserMedia 是运行时权限——manifest 权限零新增**，首次使用浏览器弹窗、可随时撤销。

**帧管线**（帧接缝为外部 review P1 采纳）：

```
requestVideoFrameCallback（与视频轨同步出帧）
  → 离屏 canvas drawImage → getImageData
  → QR2Link.decodeFrame(imageData)（qr.js 单趟引擎链，§3.3）
```

- **并发控制**：in-flight 丢帧锁（上一帧解码未完成直接丢帧，不排队）+ 150ms 节流（附加限频）；循环代号（loopSeq）递增使停循环/重建后在途回调自弃
- **命中**：停循环出横幅（结果原文 + 打开[仅 http/https] / 复制 / 「继续扫」）；流保持运行（预览不死），「继续扫」重建循环（流已停则重新 getUserMedia）
- **生命周期**：`pagehide` / `visibilitychange(hidden)` → 停循环 + **停全部 track**（帧数据仅内存处理不落盘）；扫描中被隐藏的回前台自动恢复，横幅/引导态不自动恢复
- **设备选择器**：`enumerateDevices` 报告多摄像头时显示，切换即按 `exact deviceId` 重启流；单摄像头隐藏
- **错误引导**：权限拒绝（NotAllowedError）→ 引导文案 + 重试；无设备（NotFoundError/OverconstrainedError）→ 引导文案（无重试）
- **自动打开开关**：默认关、仅会话内有效、**不持久化**（PR-4 拍板）；开启时命中 http/https 自动新开页
- **测试钩子**：`Camera.__testInjectFrame(imageData)` 与生产共用 decodeFrame 并走同一 onHit 路径；`__testStats()` 帧计数/状态探针（沿 getLastDecodeStats 先例）

---

## 6. 关键技术点

1. **Offscreen 文档生命周期**（仅 background 链路）：
   - 创建：`chrome.offscreen.createDocument({url, reasons: [chrome.offscreen.Reason.DOM_SCRAPING], justification: 'Service Worker 无 DOM/canvas，需要隐藏文档解码二维码图片'})`
   - **单实例 + 创建锁**：模块级 Promise 锁防止快捷键连击重复创建；存在性检查用 `chrome.runtime.getContexts()`（116+）
   - offscreen 文档内仅使用 `chrome.runtime` 消息通信：SW → offscreen `{type:'decode', image: dataURL|url}`，offscreen → SW `{ok, results[]}` 或 `{ok:false, error}`
   - 解码完成保持文档存活（复用），不频繁建删
2. **EXIF 方向**：`createImageBitmap(blob, {imageOrientation:'from-image'})`；不支持时回退 `<img>`（浏览器 img 解码自动应用方向）
3. **三阶段解码**（§3.3）：降采样快速识别 → 失败后原图全分辨率重试 → 仍无结果时象限分块重扫（多码整体 miss 的补救，issue #1）；框选裁剪进一步收窄
4. **反色码**：jsQR `inversionAttempts:'attemptBoth'`；原生引擎按平台自身行为，不承诺
5. **焦点**：`navigator.clipboard.read()` 要求 document 聚焦，popup 打开时天然满足；paste 双通道兜底
6. **内存**：大图解码后立即 `bitmap.close()`、canvas 置空、Blob 引用释放
7. **文案收口**（`i18n.js` → chrome.i18n，v1.7）：UI 字符串全量迁入 `_locales/{en,zh_CN}`，`i18n.js` 以 getMessage 装配 `self.I18N`（key 与调用方零变化）；key 三处同源由 `scripts/check-locales.mjs` 静态校验（run-all 前置 + 发版清单；含 `--self-test` 变异测试与 camera 页闭包，v1.2）
8. **wasm 本地执行**（v1.2）：zxing-wasm 的 `locateFile` 必须重写为 `chrome.runtime.getURL('lib/zxing_reader.wasm')`（发行版默认指向 jsDelivr CDN，违反零网络 + CWS 远程代码政策）；CSP `wasm-unsafe-eval` 为 MV3 显式要求；wasm 懒加载（首次解码才实例化，popup 打开零开销）；初始化失败永久降级 jsQR 不重试。vendor 全文件 SHA256 由 `scripts/vendor-sync.mjs` 门禁（run-all 前置 + `npm run check:vendor`）
9. **生成侧编码正确性**（v1.2，PR #6 review P1）：qr-code-styling 内嵌 qrcode-generator 的默认 `stringToBytes` 逐 UTF-16 code unit 取 `&0xff`（其 UTF-8 编码器未打进 UMD）——中文/emoji 被静默截断；调用侧先 `TextEncoder` 编码为 UTF-8 字节再逐字节映射 Latin-1 传入。容量前置闸按模式估算 bit（v40-M 三模式边界实测锚定），防 O(40×N) 同步重编码冻结弹窗
10. **摄像头帧并发**（v1.2）：rVFC 出帧与解码速率解耦——in-flight 丢帧锁 + 150ms 节流，被限帧直接跳过永不积压；`decodeFrame` 与 `decodeImage` 完全隔离（单趟、无预算、不写探针），静态图诊断契约不受帧循环影响
11. **竞态防护先例**（v1.2）：logo 选择序号（logoSeq 全路径递增，被拒选择与移除同样使在途回调失效）、摄像头循环代号（loopSeq）——异步回调一律携带归属快照，过期即自弃

---

## 7. 实施步骤

1. `git init` + 脚手架：manifest（§3.2）、目录、图标（SVG 绘制 → 16/48/128 PNG）
2. `npm i jsqr@1.4.0` → 拷贝 `dist/jsQR.js` 到 `lib/`（vendor 锁版本，提交仓库）
3. `qr.js`：能力检测 + 两阶段解码 + 多码去重 + 资源释放
4. popup：三入口、拖拽、paste、**框选裁剪组件**、结果卡片、错误态、历史（默认关）、动态宽度、`i18n.js` 文案收口
5. background.js + offscreen：快捷键直扫（自动打开第一个链接）、右键菜单、单实例锁与消息协议
6. 上架准备物：PRIVACY.md（中文，上架时部署公网）、§3.2 权限用途声明、打包 zip 脚本
7. `test/` 测试页 + 样例二维码（qrcode 库本地生成：普通/小码/反色/多码/大图小码）+ README

## 8. 验证方案

`chrome://extensions` → 开发者模式 → 加载已解压（项目根目录）；Edge 在 `edge://extensions` 同法加载。

**功能主路径**

- 截图：`test/index.html`（普通/小尺寸/反色码）→ 截图 → 全图识别 / 框选识别 → 打开链接
- 上传/拖拽：png / jpg / webp 各一张；拖拽进 popup；无码图框选重试
- 粘贴：Win+Shift+S 截屏 → Ctrl+V 及「读取剪贴板」按钮两条通道
- 摄像头：popup 入口 → 扫码页实时扫描 → 命中横幅（打开/复制/继续扫）；权限拒绝 / 无设备引导；页面切后台停摄像头
- 生成：URL 预填 / 手动输入 → 样式矩阵调整 → 下载 PNG / 复制图片 → 回环解码 = 原文
- 快捷键：Alt+Shift+S → 自动开链接；连按多次验证 offscreen 不重复创建
- 右键：页面内同源图片识别；跨域 CDN 图片优雅降级
- 历史：默认关闭 → 开启 → 保留/打开/删除/清空
- popup 宽度：紧凑态 ↔ 展开态切换与还原

**引擎与解码边界**

- 三段引擎链：native 异常静默降级；zxing 初始化失败（prepareZXingModule 抛错）→ jsQR 接管、只尝试一次、不 reject；zxing 运行期异常 → zxingBroken 永久置位；zxing 健康但空结果 → 阶段 1 jsQR 救回 / 阶段 2（≤20MP）不回落（E5 系列）
- 引擎分档边界：恰 20MP → stage2Engine=zxing；20MP+1px → jsqr（性能基准定档锁定，E6/E6b）；浏览器端 20MP 全链路 <8s（E10）
- 混合码图（QR+Code128）：原生命中后 zxing 仍执行，双结果（PR #4 review P1-1，E9）
- 全码制矩阵 11 种格式 fixture（QR/EAN13/UPCA/Code128/Code39/Code93/ITF/Codabar/DataMatrix/Aztec/PDF417）解码文本 + format canonical 名锁定（E 组；UPCA 按 zxing 语义记 EAN13 前置 0）
- 离线证明：`context.setOffline(true)` 后解码仍成功 + performance resource entries 无 CDN 外联（E7，本迭代最重要验收）
- 一图两码：zxing 阶段 1 整图多码；jsQR 应急路径无结果时阶段 3 分块救回多卡片（v1.5，issue #1；全图已能解出 ≥1 码时不分块）；框选单码始终可用
- 最坏全 miss（9MP 高频纹理）→ 重扫墙钟预算 8s 内截停完成，offscreen 消息链不超时（A15，v1.6）；阶段选择边界 9MP / 50MP 两侧行为锁定（B37–B40，经 `getLastDecodeStats` 探针）
- 大图小码（如 8000px 图中 120px 码）→ 阶段 2 命中
- 反色 / 低对比度 / 旋转 / 轻透视变形码
- 无码图片（明确报错）；URL 前后带空格（trim）

**自动化验收（test/e2e，DESIGN §8 的可自动化子集）**

Playwright 驱动真实浏览器（Edge 品牌版 / Playwright Chromium）加载未打包扩展，**141 用例 × 九组 A–I**，同一套用例 `QR2LINK_E2E_LANG={zh-CN,en-US}` 双语回归（四轮全绿为发版门禁；实测记录见 TEST-RESULTS.md）：

| 组 | 覆盖 | 用例数 |
|---|------|-------|
| A | SW / offscreen / badge / 右键链路 / 协议白名单 | 16 |
| B | popup UI（上传/拖拽/剪贴板/框选/结果/历史/宽度/原生注入分支） | 40 |
| C | 截图主路径（OS 手势授权 activeTab → 真实截图 → 预览框选） | 5 |
| D | 手势 / 特殊页面可截性矩阵 | 8 |
| E | zxing 引擎 / 全码制 / 分档边界 / 离线证明 | 15 |
| F | 结构化解析（正向 + 负面/边界） | 24 |
| G | 安全预检（分级/reasons 排序/danger 两段式/快捷键不预检契约） | 7 |
| H | 生成二维码（预填/草稿/样式矩阵/下载/复制/logo 边界/UTF-8/防冻结） | 16 |
| I | 摄像头（真实链路层 fake media + 确定性解码层注入帧 + 错误路径） | 10 |

> 品牌版 Chrome 137+ 忽略 `--load-extension` → 用 msedge / chromium 通道；摄像头用例用 `--use-fake-device-for-media-stream`（绿球视频轨）+ `--use-fake-ui-for-media-stream`（权限自动授予）。run-all 第 0 步前置门禁：check-locales + vendor-sync（SHA256）。

**剪贴板边界**

- 纯文本剪贴板；文本+HTML+图片混合（只取图片）；超大剪贴板图
- popup 失焦后按 Ctrl+V 的实际表现

**特殊页面截图实测（以 captureVisibleTab 实际返回为准）**

- chrome://settings、chrome://extensions、PDF 查看器、Chrome Web Store、其他扩展页面 → 记录每个页面的真实可截性，失败走引导提示

**Edge 兼容实测（目标浏览器之一）**

- 加载与三入口主路径、`chrome.offscreen` / `commands` / `contextMenus` / `BarcodeDetector` / `navigator.clipboard.read` 逐项验证
- Edge 特有页面（edge://settings 等）截图可截性记录

**安全**

- `javascript:` / `data:` / 纯文本码 → 仅展示+复制，不打开
- 结果渲染用 textContent（代码审查项）
- 「复制」之外无任何剪贴板写入路径（代码审查项）

## 9. 风险与边界（已知取舍）

| 风险 | 处理 |
|------|------|
| 特殊页面可截性不一（chrome:// 等） | 以实测为准；失败引导粘贴/上传，文档不承诺 |
| Edge 各 API 行为差异 | §8 Edge 实测矩阵；Chromium 同源，风险低 |
| BarcodeDetector 平台差异 / 异常 | 运行时能力检测 + try/catch，静默降级（与 zxing 合并、命中去重） |
| zxing wasm 初始化失败（CSP 回归/浏览器 bug/文件损坏） | `zxingBroken` 永久置位降级 jsQR（拍板④），不重试；E5c/E5d 锁定 |
| 20MP 档无运行时硬上限（wasm 单趟不可中断，慢设备最坏 3.7s+） | 已接受风险（PR #4 review P1-2）：20MP 档为性能基准达标线（≤5s），另由 offscreen 15s 超时兜底；最坏情况严格优于 v1.1 的 jsQR@9MP 29s |
| 全码制误报（拍板⑧） | zxing-cpp 内建校验保守；E 组 11 种格式矩阵锁定；README 收敛「主流二维码与条码」不承诺穷举 |
| >20MP 混合码在 native 命中 QR 时 1D 可能漏 | 已知边界（该档刻意不走 zxing 控耗时，已接受）；框选重试兜底 |
| jsQR 仅单码（应急路径） | 阶段 3 象限分块重扫（v1.5，issue #1）：无结果时 1×2/2×1/2×2/4×4 梯子分块，均布多码可救；已解出 ≥1 码时不分块、极端布局仍 miss → 框选重试兜底 |
| 慢设备上重扫（阶段 2+3）耗时超 offscreen 15s 消息超时 | 重扫墙钟预算 8s（v1.6，外部 review #2）：阶段 3 逐 tile 检查、超时截停梯子尾部，落「框选重试」；像素预算（50MP/20MP/9MP 档）另限扫描量 |
| 大图小码漏识别 | 三阶段解码 + 框选裁剪；超 50MP 契约不变（阶段 3 仅在阶段 2 实际执行过才进入） |
| 摄像头权限拒绝 / 无设备 / 设备被占用 | 分类引导文案（拒绝可重试、无设备不可重试）；不进 manifest 权限，用户可随时撤销 |
| 摄像头页遗忘（标签页常驻） | pagehide / visibilitychange(hidden) 停全部 track；横幅态不自动恢复须显式「继续扫」 |
| 右键跨域图片取不到 | 标注实验性；提示截图/上传替代；不为此加 `<all_urls>` |
| 历史含敏感信息（含 otpauth secret） | 默认关闭、仅存主动保留文本、一键清空、显示层打码、README/PRIVACY 明示存储行为 |
| 剪贴板焦点问题 | 按钮主动读 + paste 监听双通道，失败提示手动 Ctrl+V |
| 超大图内存 | 解码后释放 bitmap/canvas/Blob；生成侧容量前置闸防 MB 级同步编码 |

## 10. 评审与决策记录

- **外部 review**（2026-11-01）：Manifest 权限缺失、BarcodeDetector 运行时检测、jsQR 单码与多码承诺矛盾、固定降采样风险、隐私声明与 fetch 冲突、storage 敏感数据风险等**全部采纳**；「象限分块」留作后续；快捷键自动打开经讨论保留。
- **grill 自审**（2026-11-01，两轮拷问）：① 目标浏览器 **Chrome+Edge**（Firefox 排除，避免双后台架构）；② 分发 **按可上架标准准备**（含 PRIVACY.md、权限用途声明，暂不提交审核）；③ 复制行为 **手动复制、不自动写入剪贴板**；④ 框选容器 **popup 动态加宽 ~760px**（紧凑态默认，不做全屏框选页）；⑤ 命名 **QR2Link**；⑥ UI **仅中文、文案收口 `i18n.js`**。
- **工程默认值**（自审认定，随 v1.2 固化）：快捷键多链接只自动打开第一个 http/https；上架时再部署隐私政策公网 URL；`git init`、版本 1.0.0 起；测试二维码用 qrcode 库本地生成不依赖网络。
- **issue #1 多码分块**（2026-11-01，v1.5）：采纳 issue 后续迭代方向的第一项「象限分块」，并按实测修正为 **1×2 / 2×1 / 2×2 / 4×4 几何梯子**——纯 2×2 会把近满幅的并排/堆叠双码拦腰切断（two-codes.png 实测全 miss），必须先跑单轴切分。区域分割预处理与 zxing-wasm 换解码器两条路线仍留在 issue 备选（后者已于 v1.2 落地，见下）。
- **v1.2「双向工具箱」拍板**（2026-11-13，grill 拷问三轮 8 项，全文见 V1.2-PLAN「拍板记录」）：① otpauth **本地生成** TOTP 动态码（WebCrypto，RFC 官方向量锁定；secret 默认打码；HOTP 仅展示）；② 选中文本右键生成入口**不加**（入口收敛弹窗内）；③ 快捷键直扫遇 danger **维持照常打开**（README 明示预检边界）；④ jsQR **保留应急**（zxingBroken 永久降级）；⑤ 阶段 3 象限梯子**保留**（多码承诺与 B37–40 契约不动）；⑥ 生成视图**弹窗内嵌**（草稿存 storage.session）；⑦ 弹窗 danger 打开**两段式确认**（3s 解除）；⑧ 码制识别**全码制**（formats 留空；README 收敛「主流」措辞）。
- **v1.2 外部 review 与 AIbot review 处置**：外部 review P1×8 / P2 若干 采纳（帧接缝 decodeFrame、性能基准矩阵、pack-zip INCLUDE 纠错、vendor SHA256、qr-code-styling 许可单列等；唯一驳回「提交 lockfile」——仓库既有惯例刻意排除，可复现性由钉版 + SHA256 闭环）；PR #4/#5/#6 AIbot review 全部处置采纳（P1×2+P2×4+P3×1 / P1×2+P2×4 / P1×2+P2×4+复核 P2×1），明细见 V1.2-PLAN 文末处置表。

## 11. 参考来源

- [zxing-cpp / zxing-wasm](https://github.com/zxing-cpp/zxing-cpp) — WebAssembly 解码引擎（v1.2 主引擎）
- [kozakdenys/qr-code-styling](https://github.com/kozakdenys/qr-code-styling) — 生成视图渲染库（内嵌 qrcode-generator）
- [cozmo/jsQR](https://github.com/cozmo/jsQR) — 应急解码库
- [serkonda7/image-qr-scanner-extension](https://github.com/serkonda7/image-qr-scanner-extension) — jsQR + MV3 参考
- [mubaidr/QR-Code-Extension](https://github.com/mubaidr/QR-Code-Extension) — 截图识别参考
- [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238)（TOTP）· [RFC 3492](https://datatracker.ietf.org/doc/html/rfc3492)（Punycode，safety.js 同形检测）
- [Chrome: WebAssembly in MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy) ·
  [Chrome: Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) ·
  [Chrome: Commands](https://developer.chrome.com/docs/extensions/reference/api/commands) ·
  [Chrome: Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [MDN: BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector) ·
  [MDN: MediaDevices.getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) ·
  [MDN: VideoFrame.requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/requestVideoFrameCallback)
- [MDN tabs API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs) ·
  [MDN 剪贴板交互](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard)
- [SO: 扩展 popup 剪贴板权限](https://stackoverflow.com/questions/54325731/how-do-i-prompt-user-for-clipboard-read-permission-in-the-popup-of-a-chrome-ex)
