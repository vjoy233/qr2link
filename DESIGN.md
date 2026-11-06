# QR2Link — 二维码转网页链接 Chrome 插件 · 方案设计文档

> 版本：v1.7（2026-11-05）
> 状态：已评审通过（含外部 review 修订 + grill 自审拷问）
> 项目目录：`D:\Vibing\qr2link`

**变更记录**

| 版本 | 说明 |
|------|------|
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

在浏览器里遇到二维码（网页上的登录码、支付码、分享码等）时，用户往往需要掏手机扫描。本插件让浏览器自己「看懂」二维码：

把**任何含二维码的图片**在本地识别成文本 / 网页链接，并可一键打开。

三个核心入口：

| # | 功能 | 说明 |
|---|------|------|
| 1 | **网页截图识别** | 截取当前网页可视区域，**可框选裁剪二维码区域**后识别 |
| 2 | **本地图片上传识别** | 上传 / 拖拽本地图片文件，识别其中的二维码 |
| 3 | **剪贴板粘贴识别** | 读取剪贴板图片（如 Win+Shift+S 截图）或 Ctrl+V 粘贴，识别其中的二维码 |

附加功能（随首版一并交付，见 §5）：快捷键直扫、右键图片识别、识别历史（默认关闭）。

**设计原则**

- 不重复造轮子：解码复用成熟方案（原生 API + jsQR）
- 隐私优先：识别内容只在本地处理、不上传第三方服务（完整声明见 §1.1）
- 权限最小化：不引入 `<all_urls>` / `tabs` / `host_permissions`

**产品范围边界（明确不支持）**

- 截图为**当前标签页可视区域**，不支持整页长截图、不自动滚动
- 不截取浏览器外部内容（屏幕/窗口级截图属 `chrome.desktopCapture`，超出本版范围）
- 不做摄像头实时扫码
- 不支持 Firefox（见产品要素表）

### 1.1 隐私声明（准确版）

> 图片与二维码内容**全部在本地解码，不上传任何第三方服务**。
> 例外：右键识别网页上的远程图片时，浏览器会**向该图片的原始地址**发起请求以获取图片字节；能否成功取决于该图片的跨域与访问限制（见 §5.2）。
> 识别历史仅存于本机 `chrome.storage.local`，**默认关闭**，开启后只保存用户主动保留的文本结果，不保存图片（见 §5.3）。
> 识别结果**不会自动写入剪贴板**，仅用户点击「复制」时写入（见 §4.4）。

---

## 2. 技术调研结论

### 2.1 二维码解码 —— 双引擎策略

| 方案 | 评估 | 结论 |
|------|------|------|
| **BarcodeDetector API**（浏览器原生） | **可选的原生加速引擎**：接口与支持格式是平台相关的，须运行时检测；支持时一次 `detect()` 可能返回图中多个二维码 | ✅ 检测通过时优先使用 |
| **jsQR**（cozmo/jsQR，4k★，Apache-2.0） | 纯 JS 社区标准库，跨平台行为一致，`jsQR(imageData, w, h, {inversionAttempts:'attemptBoth'})` 一行接入，支持反色码 | ✅ 基线引擎（原生不可用 / 构造失败 / 识别失败时兜底） |
| zxing-js / html5-qrcode | 更重（多格式 / 摄像头 UI 框架），QR-only 场景无优势 | ❌ 不采用 |

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

原生引擎的构造与 `detect()` 全程包裹 try/catch，任何异常静默降级 jsQR，不影响功能。

**多码能力承诺（v1.5 起）：**

> 首版**保证识别图片中的一个二维码**；原生 BarcodeDetector 可用时展示其返回的多个结果（去重）。jsQR 兜底路径对**无结果**的多码图自动进入**阶段 3 象限分块重扫**（§3.3），常见均布布局（并排/堆叠双码、四角四码）可跨引擎一致地返回多个结果；jsQR 已解出 ≥1 码时不分块（无法廉价判断是否存在漏网码），极端布局仍可能 miss → 「框选重试」兜底。

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
├── manifest.json          # MV3 清单（default_locale=en，描述走 __MSG_）
├── _locales/              # chrome.i18n 语言包（en + zh_CN，42 key；check-locales 守门）
├── background.js          # Service Worker：快捷键直扫、右键菜单、offscreen 生命周期
├── offscreen.html/.js     # Offscreen 文档：为 SW 提供 canvas 解码环境（仅快捷键/右键链路使用）
├── qr.js                  # 共享解码模块（popup / offscreen 共用）
├── i18n.js                # UI 文案装载（chrome.i18n → self.I18N，调用方零改动）
├── popup/
│   ├── popup.html         # 主 UI
│   ├── popup.js
│   ├── popup.css
│   └── crop.js            # 截图预览 + 框选裁剪组件（共享给上传/粘贴的失败重试）
├── lib/
│   └── jsQR.js            # jsqr@1.4.0 官方 dist（vendor，锁版本）
├── icons/                 # 16 / 48 / 128 PNG
├── test/                  # 本地测试页 + 样例二维码（qrcode 库本地生成，不依赖网络）
├── PRIVACY.md             # 隐私政策（上架时部署到公网 URL 并在商店后台登记）
├── README.md
└── .gitignore
```

**职责划分**：三大核心入口（截图/上传/粘贴）**全部在 popup 内直接解码**，不经过 SW；`background.js + offscreen` 仅服务「popup 关闭后仍要执行」的场景（快捷键直扫、右键识别）。

### 3.2 Manifest（首版完整声明，一次做全）

```json
{
  "manifest_version": 3,
  "name": "QR2Link",
  "version": "1.0.0",
  "description": "截图 / 上传 / 粘贴图片，本地识别二维码并打开网页链接",
  "minimum_chrome_version": "116",
  "action": { "default_popup": "popup/popup.html", "default_title": "QR2Link" },
  "background": { "service_worker": "background.js" },
  "permissions": [
    "activeTab", "clipboardRead", "clipboardWrite",
    "contextMenus", "offscreen", "storage"
  ],
  "commands": {
    "scan-current-page": {
      "suggested_key": { "default": "Alt+Shift+S" },
      "description": "截图并识别当前网页中的二维码"
    }
  }
}
```

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

### 3.3 解码管线（qr.js，纯本地，两阶段）

```
图片源(dataURL / Blob / URL)
  → createImageBitmap(file, {imageOrientation:'from-image'})  ← 修正 EXIF 方向；失败回退 <img>
  ┌─ 阶段1（快速）：最长边 > 2000px 时等比降采样 → ImageData
  │    → ① canUseNativeQr() 通过 → BarcodeDetector({formats:['qr_code']}).detect()
  │    → ② 无结果或原生异常 → jsQR(..., {inversionAttempts:'attemptBoth'})
  ├─ 阶段2（无结果时重试）：原图全分辨率 → 同引擎序列重试
  │    （覆盖「大图中的小二维码」：如 8000px 图中 120px 的码，全分辨率下保持原尺寸可识别）
  │    像素预算 ≤50MP；超出跳过（避免内存暴涨），落「框选重试」
  │    ‖ 重扫墙钟预算自此起算（8s，v1.6）：阶段 2 单趟不可中断（上界即像素预算），
  │    预算用于阻止阶段 3 在其上叠加——慢设备上截停梯子尾部投机趟次
  └─ 阶段3（仍无结果时，issue #1 多码分块）：仅阶段 2 实际执行过才进入
       按几何梯子 1×2 / 2×1 / 2×2 / 4×4 逐块跑同引擎序列，全部扫完合并
       rect ≤9MP（4K 截图级）逐块全分辨率；更大图按阶段 1 档位（≤2000px）分块
       逐 tile 检查墙钟预算，超时截停剩余趟次（已扫部分照常合并返回）
  → 文本去重 → [{ text, isUrl, engine }]
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

- **紧凑态（默认 ~400px）**：三入口按钮 + 历史
- **展开态（~760px）**：进入截图框选 / 图片预览 / 结果视图时加宽，保证大截图缩放预览后仍有画框精度

```
┌─────────────────────────────┐
│  QR2Link  二维码 → 链接      │
│ ┌─────────┐ ┌─────────┐    │
│ │ 📸 截取  │ │ 📁 上传  │    │
│ │ 当前网页 │ │ 图片     │    │
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
- popup 内打开链接由用户点击触发；唯一自动打开路径是快捷键直扫（§5.1，快捷键本身即用户显式手势）
- URL 前后空白 `trim()` 后展示原始文本

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
- 历史条目可打开（URL）/ 复制 / 删除

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
7. **文案收口**（`i18n.js` → chrome.i18n，v1.7）：UI 字符串全量迁入 `_locales/{en,zh_CN}`，`i18n.js` 以 getMessage 装配 `self.I18N`（key 与调用方零变化）；key 三处同源由 `scripts/check-locales.mjs` 静态校验（run-all 前置 + 发版清单）

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
- 快捷键：Alt+Shift+S → 自动开链接；连按多次验证 offscreen 不重复创建
- 右键：页面内同源图片识别；跨域 CDN 图片优雅降级
- 历史：默认关闭 → 开启 → 保留/打开/删除/清空
- popup 宽度：紧凑态 ↔ 展开态切换与还原

**引擎与解码边界**

- BarcodeDetector 存在但不支持 qr_code（模拟禁用）→ jsQR 降级
- 原生 detect() 抛异常 → 降级
- 一图两码：原生环境展示多卡片；jsQR 环境无结果时阶段 3 分块救回多卡片（v1.5，issue #1；全图已能解出 ≥1 码时不分块）；框选单码始终可用
- 最坏全 miss（9MP 高频纹理）→ 重扫墙钟预算 8s 内截停完成，offscreen 消息链不超时（A15，v1.6）；阶段选择边界 9MP / 50MP 两侧行为锁定（B37–B40，经 `getLastDecodeStats` 探针）
- 大图小码（如 8000px 图中 120px 码）→ 阶段 2 命中
- 反色 / 低对比度 / 旋转 / 轻透视变形码
- 无码图片（明确报错）；URL 前后带空格（trim）

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
| BarcodeDetector 平台差异 / 异常 | 运行时能力检测 + try/catch，全程 jsQR 兜底 |
| jsQR 仅单码 | 阶段 3 象限分块重扫（v1.5，issue #1）：无结果时 1×2/2×1/2×2/4×4 梯子分块，均布多码可救；已解出 ≥1 码时不分块、极端布局仍 miss → 框选重试兜底 |
| 慢设备上重扫（阶段 2+3）耗时超 offscreen 15s 消息超时 | 重扫墙钟预算 8s（v1.6，外部 review #2）：阶段 3 逐 tile 检查、超时截停梯子尾部，落「框选重试」；像素预算（50MP/9MP 档）另限扫描量 |
| 大图小码漏识别 | 两阶段解码 + 框选裁剪；超 50MP 契约不变（阶段 3 仅在阶段 2 实际执行过才进入） |
| 右键跨域图片取不到 | 标注实验性；提示截图/上传替代；不为此加 `<all_urls>` |
| 历史含敏感信息 | 默认关闭、仅存主动保留文本、一键清空、README/PRIVACY 明示存储行为 |
| 剪贴板焦点问题 | 按钮主动读 + paste 监听双通道，失败提示手动 Ctrl+V |
| 超大图内存 | 解码后释放 bitmap/canvas/Blob |

## 10. 评审与决策记录

- **外部 review**（2026-11-01）：Manifest 权限缺失、BarcodeDetector 运行时检测、jsQR 单码与多码承诺矛盾、固定降采样风险、隐私声明与 fetch 冲突、storage 敏感数据风险等**全部采纳**；「象限分块」留作后续；快捷键自动打开经讨论保留。
- **grill 自审**（2026-11-01，两轮拷问）：① 目标浏览器 **Chrome+Edge**（Firefox 排除，避免双后台架构）；② 分发 **按可上架标准准备**（含 PRIVACY.md、权限用途声明，暂不提交审核）；③ 复制行为 **手动复制、不自动写入剪贴板**；④ 框选容器 **popup 动态加宽 ~760px**（紧凑态默认，不做全屏框选页）；⑤ 命名 **QR2Link**；⑥ UI **仅中文、文案收口 `i18n.js`**。
- **工程默认值**（自审认定，随 v1.2 固化）：快捷键多链接只自动打开第一个 http/https；上架时再部署隐私政策公网 URL；`git init`、版本 1.0.0 起；测试二维码用 qrcode 库本地生成不依赖网络。
- **issue #1 多码分块**（2026-11-01，v1.5）：采纳 issue 后续迭代方向的第一项「象限分块」，并按实测修正为 **1×2 / 2×1 / 2×2 / 4×4 几何梯子**——纯 2×2 会把近满幅的并排/堆叠双码拦腰切断（two-codes.png 实测全 miss），必须先跑单轴切分。区域分割预处理与 zxing-wasm 换解码器两条路线仍留在 issue 备选，不随本版实现。

## 11. 参考来源

- [cozmo/jsQR](https://github.com/cozmo/jsQR) — 解码库
- [serkonda7/image-qr-scanner-extension](https://github.com/serkonda7/image-qr-scanner-extension) — jsQR + MV3 参考
- [mubaidr/QR-Code-Extension](https://github.com/mubaidr/QR-Code-Extension) — 截图识别参考
- [Chrome: Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) ·
  [Chrome: Commands](https://developer.chrome.com/docs/extensions/reference/api/commands) ·
  [Chrome: Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [MDN tabs API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs) ·
  [MDN 剪贴板交互](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard)
- [SO: 扩展 popup 剪贴板权限](https://stackoverflow.com/questions/54325731/how-do-i-prompt-user-for-clipboard-read-permission-in-the-popup-of-a-chrome-ex)
