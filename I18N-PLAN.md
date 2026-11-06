# QR2Link 中英双语适配方案（I18N Plan）

> 状态：**已实施完成（2026-11-05，PR #3），双语回归 3×69 全绿** · grill 审核结论见 §3.1 / §10 · 分支 `feat/i18n-bilingual`（从 main 切，前置 issue-1 已合入）
> 目标：中英文双语**完美**支持——UI 文案、manifest 描述、右键菜单、快捷键说明全部随浏览器语言自动切换，中文行为零回归。

---

## 0. 结论摘要（TL;DR）

采用 **Chrome 平台原生 `chrome.i18n` + `_locales/` 目录**方案（Chrome/Edge 自动按浏览器 UI 语言匹配，零运行时开销、零设置界面、商店元数据同步本地化）。

- 新增 `_locales/en/messages.json` + `_locales/zh_CN/messages.json`（约 42 条消息）
- `i18n.js` 改为从 `chrome.i18n.getMessage()` 装配 `self.I18N`，**对外接口与 key 完全不变**（popup.js / crop.js / background.js 零改动，兑现 DESIGN §6.7「只做翻译映射，不改调用方」的承诺）
- `manifest.json` 的 `description` 与快捷键 `description` 改 `__MSG_` 占位符，加 `default_locale`
- **关键配套**：`pack-zip.mjs` 必须加入 `_locales`（漏掉 = 发布包损坏）；e2e 断言去硬编码中文；新增 locale 完整性静态检查脚本
- 预计代码改动量 ~250 行（不含文档），半天开发 + 半天双语回归

---

## 1. 现状盘点：中文在哪里、谁在消费

全仓中文文案分布（排除注释、`.zcode/`、测试报告）：

| 位置 | 内容 | 消费方式 | 是否用户可见 |
|------|------|----------|--------------|
| `i18n.js` | 40 个 key 的全部 UI 文案 | `self.I18N`（popup.js / crop.js 经 `T.`；background.js 经 `self.I18N.`） | ✅ 全部 |
| `manifest.json:5` | `description`「截图 / 上传 / 粘贴图片…」 | Chrome 商店 / 扩展管理页 | ✅ |
| `manifest.json:21` | 快捷键 `description`「截图并识别当前网页中的二维码」 | `chrome://extensions/shortcuts` 页 | ✅ |
| `popup/popup.html:2` | `lang="zh-CN"` 硬编码 | 无障碍 / 字体选择 | ✅（间接） |
| `background.js:29` | offscreen `justification` 中文（商店审核用） | 仅审核面板可见 | ⚠️ 低危，建议顺带英文化 |
| `test/e2e/run-all.cjs` | 断言硬编码中文（菜单标题 / 「复制」「打开」「识别所选区域」等，~10 处） | 测试 | ❌ 但语言切换后会**误报** |
| `scripts/pack-zip.mjs` | INCLUDE 白名单**不含 `_locales`** | 打包 | ❌ 但改造后**必须补** |
| `README.md` / `PRIVACY.md` | 全中文文档 | GitHub / 商店隐私声明来源 | ✅（面向国际用户需英文版） |
| `test/index.html` | 测试页说明文字 | 本地开发测试页 | ❌ 仅开发者 |
| `package.json:5` | description 中文 | npm 元信息 | ❌ 仅开发者 |

**利好**：项目当初已按「文案收口」架构设计——HTML 全走 `data-i18n`、JS 全走 `T.`、无一处 innerHTML 硬编码中文。本次改造是**收口方案的既定演进路径**，不是重构。

---

## 2. 方案选型

| 维度 | 方案 A：`chrome.i18n`（推荐） | 方案 B：自研语言包 + 设置内语言开关 |
|------|------------------------------|-------------------------------------|
| 语言跟随 | 浏览器 UI 语言，自动 | 用户手动切换（需存储 + 设置 UI） |
| manifest 本地化 | ✅ 原生支持 `__MSG_` | ❌ 商店/管理页描述仍单语 |
| 运行时开销 | 无（启动时由 Chrome 解析） | 每次读文件/查表 |
| 代码量 | 少（i18n.js 改造 ~30 行） | 多（locale 文件加载、语言状态、设置 UI、切换后全量刷新） |
| 商店生态 | Chrome Web Store 官方机制，审核友好 | 非标 |
| 缺点 | 用户无法在扩展内手动覆盖语言（须改浏览器语言） | 三份语言数据源要自己维护同步 |

**结论：方案 A。** 「完美双语」由平台保证匹配正确性；「扩展内语言开关」是伪需求（Chrome 生态下用户预期即跟随浏览器语言，且本扩展无 options 页，加设置页反而破坏「零配置」定位）。

语言匹配链（Chrome 自动完成）：`浏览器语言精确匹配（zh-CN→zh_CN）→ 父语言（en-GB→en）→ default_locale`。

---

## 3. 关键设计决策

**D1–D4 已确认（2026-11-05，项目 owner 拍板）**：

| # | 决策点 | **结论（已拍板）** | 依据 |
|---|--------|--------------------|------|
| D1 | `default_locale` 取值 | **`"en"`** —— 法/德/日等无语言包的浏览器回落英文；中文用户精确命中 `zh_CN` 不受影响 | 国际用户回落英文比回落中文合理；已确认 ✅ |
| D2 | 应用名是否本地化 | **保持 `QR2Link` 纯品牌不翻译**，仅 `description` 本地化 | 现状即纯英文，商店搜索一致性好；已确认 ✅ |
| D3 | `action.default_title`（悬停提示） | **保持 `"QR2Link"` 不动** | 无信息增益；已确认 ✅ |
| D4 | 文档双语组织 | **独立英文文件**：新增 `README.en.md` + `PRIVACY.en.md` 全译，中文版顶部互链；不搞单文件混排 | 商店上架国际区需要英文隐私声明；已确认 ✅ |

### 3.1 grill 审核结论（2026-11-05，owner 拍板）

| # | 议题 | 结论 |
|---|------|------|
| Q1 | 分支基线（issue-1 分支领先 main 1 提交未合入） | **先合 issue-1 → 再从 main 切 `feat/i18n-bilingual`**，两 feature 独立 PR |
| Q2 | zh-TW/zh-HK 用户回落 | **本期不补 `zh_TW`，接受英文回退**（定性升级见 §7-R4；README 已知限制 + GitHub issue 待办） |
| Q3 | check:locales 守门机制（仓库无 CI） | **本地 e2e 前置 + 发版清单**：run-all 第一步强制执行 check-locales，失败即中止；不建 CI |
| Q4 | e2e 英文回归矩阵 | **en 只跑 chromium；zh 保持 chromium + msedge 双 channel**（共 3 遍全量） |
| Q5 | 英文翻译表定稿方式 | **按 §5 建议稿直接定稿**（保留 Win+Shift+S / Ctrl+V 等 Windows 措辞，与中文版举例对称）；已确认 ✅ |
| Q6 | 版本号与发布节奏 | **v1.1.0**，双语回归 + 打包验收通过后随下一个 GitHub Release 发布（release notes 中英双语）；已确认 ✅ |

审核中查证的事实（已修正方案）：

- **Chrome 扩展 locale 不存在裸 `zh`**（仅 `zh_CN`/`zh_TW`，全部合法 locale 共 55 个）——zh-TW/HK 用户无法经父语言命中 zh_CN，将直接回落 default_locale。原方案 R4 把这定性为「低影响」是错的：现网硬编码简中，港台用户今天看的是简体中文，改造后变英文，**属体验回退**（已按 Q2 拍板接受并留待办）。
- 仓库无任何 CI 基建（无 `.github/`）→ Q3 选项收敛为本地守门。

其他既定取向（无需拍板，列出供核对）：

- locale 目录用 **`en`**（覆盖 en-US/en-GB 等所有变体）+ **`zh_CN`**（Chrome 目录命名用下划线）
- messages.json 的 key 采用 **snake_case**（`btnScreenshot` → `btn_screenshot`），`i18n.js` 内做 camel→snake 转换，调用方 `T.btnScreenshot` 签名零变化
- **不做** `zh_TW` 繁体包（本期范围外；zh-TW 用户将回落 default，见 §7-R4）
- 不引入占位符机制（`placeholders`）——全量检查后唯一的动态拼接是 `T.textLabel + ' · ' + r.engine`，`·` 分隔符语言中立，保持代码拼接

---

## 4. 逐文件改动清单

### 4.1 新增 `_locales/en/messages.json` + `_locales/zh_CN/messages.json`

- 40 个现有 key（snake_case 化）+ 2 个新增 key（`manifest_description`、`command_scan_description`），每条带 `description` 字段说明上下文（便于后续翻译协作）
- 英文全文见 §5 翻译表；zh_CN 即现有 `i18n.js` 文案原样搬运，**一字不改**（保证中文零回归）
- 示例结构：

```json
{
  "btn_screenshot": {
    "message": "Capture current page",
    "description": "Home view entry button: captures the visible area of the active tab"
  }
}
```

### 4.2 `i18n.js` 改造（核心，接口不变）

```js
/**
 * i18n.js — UI 文案装载（chrome.i18n 双语版，DESIGN §6.7 演进）
 * 对外接口 self.I18N.<camelKey> 与旧版完全一致，调用方零改动。
 * key 三处同源：_locales/{en,zh_CN}/messages.json 与本文件 KEYS，
 * 由 scripts/check-locales.mjs 静态校验强一致。
 */
(function () {
  'use strict';

  var KEYS = [
    'appName', 'appSubtitle', /* …与 _locales 严格一致，40 项… */
  ];

  function snake(k) { return k.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); }

  self.I18N = KEYS.reduce(function (T, k) {
    // getMessage 对缺失 key 返回 ""：兜底显示 key 名本身，漏翻译在 UI 上一眼可见
    T[k] = chrome.i18n.getMessage(snake(k)) || k;
    return T;
  }, {});
})();
```

注意：`chrome.i18n.getMessage` 在 popup / offscreen / Service Worker 三种环境均可用（Chrome 116+ 满足）；`importScripts('i18n.js')`（background.js:10）无需改动。

### 4.3 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "QR2Link",
  "version": "1.1.0",
  "default_locale": "en",
  "description": "__MSG_manifest_description__",
  ...
  "commands": {
    "scan-current-page": {
      "suggested_key": { "default": "Alt+Shift+S" },
      "description": "__MSG_command_scan_description__"
    }
  }
}
```

- **manifest 一旦含 `__MSG_`，`default_locale` 为必填**；Chrome 在加载时解析，缺 key 会直接拒绝加载（见 §7-R1 风险与对策）
- 版本号建议 `1.0.0 → 1.1.0`（功能级变更）
- `background.js:29` offscreen `justification` 顺带改为英文（商店审核人员读）：`"Decode QR images locally in a hidden document; the service worker has no DOM/canvas."`

### 4.4 `popup/popup.js`（+3 行）

`applyI18n()` 末尾补 `lang` 属性动态化（无障碍 + 字体选择正确性）：

```js
var ui = chrome.i18n.getUILanguage();          // 如 "zh-CN" / "en-US"
document.documentElement.lang = /^zh\b|^-?zh/i.test(ui) ? 'zh-CN' : 'en';
```

### 4.5 `background.js`（+8 行，语言切换滞后修复）

右键菜单当前仅在 `onInstalled` 创建（background.js:113）。用户日后更改浏览器 UI 语言时（Chrome 要求重启生效），`onInstalled` 不触发、菜单标题停留在旧语言。补 `onStartup` 重建：

```js
function createMenu() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: MENU_ID, title: self.I18N.menuScanImage, contexts: ['image'] });
  });
}
chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu); // 浏览器改语言必重启 → 重启时按新语言重建菜单
```

（Chrome 改 UI 语言的交互必经「重启浏览器」，故 onStartup 覆盖即完备。）

### 4.6 `scripts/pack-zip.mjs`（关键配套）

`INCLUDE` 数组加入 `'_locales'`。**这是发布链路的关键点**：manifest 含 `__MSG_` 而包内无 `_locales` 时，Chrome 直接判定扩展损坏无法加载。

### 4.7 新增 `scripts/check-locales.mjs`（静态完整性检查，零浏览器依赖）

校验四件事，任一失败非零退出：

1. `en` 与 `zh_CN` 的 key 集合完全一致
2. 两份文件所有 `message` 非空、无重复 key
3. `i18n.js` 的 `KEYS` 与 locale key 双向差集为空（防三处漂移）
4. 代码实际引用 ⊆ locale key：扫描 `data-i18n="…"`（popup.html）与 `T\./I18N\.` 引用（popup.js / crop.js / background.js）；`manifest.json` 的 `__MSG_x__` token 可解析

并注册 `package.json` script：`"check:locales": "node scripts/check-locales.mjs"`。

守门场合（grill Q3 拍板）：`run-all.cjs` 启动第一步强制执行本脚本，任一校验失败即中止全部用例；同时列入发版清单（§6.2）。**不引入 CI**。

### 4.8 测试改造（`test/e2e/helpers.cjs` + `run-all.cjs`）

**原则：同一套 e2e 双语各跑一遍，而不是只抽查几句。**

1. `helpers.cjs` `launch({ channel, lang })`：追加启动参数 `--lang=${lang}`（默认 `zh-CN`，锁定现有报告/截图语言不漂移）；新增 `msg(key, locale)` 助手直接读 `_locales/<locale>/messages.json`
2. `run-all.cjs`：
   - 读环境变量 `QR2LINK_E2E_LANG`（默认 `zh-CN`）传入 `launch()`
   - 硬编码中文断言全部改 `msg('btn_copy')`、`msg('menu_scan_image')`…（~10 处：A 系菜单标题、B 系「复制/已复制/打开/识别所选区域」等）
   - 新增 2 个 i18n 专项用例：
     - **N1**：`chrome.runtime.getManifest().description` 已解析为当前语言文案（en 运行下为英文，zh 运行下为中文）——验证 manifest `__MSG_` 链路
     - **N2**：popup `<html lang>` 与 `chrome.i18n.getUILanguage()` 一致性（无障碍回归）
3. 双语矩阵执行（grill Q4 拍板）：**中文回归 = chromium + msedge 双 channel；英文回归 = 仅 chromium**（Edge 与 Chromium 同引擎，i18n/渲染行为一致），合计 3 遍全量
4. 开工前置探针：动手先验证 `--lang=en-US` 确实改变 `chrome.i18n.getUILanguage()`；若不生效，退路为 prefs `intl.accept_languages`（只改 `helpers.launch` 一处）

### 4.9 文档

| 文件 | 动作 |
|------|------|
| `README.en.md` | 新增，全译（安装/功能/权限表/隐私摘要/快捷键） |
| `README.md` | 顶部加一行 `English | 中文` 切换链接；「功能」节补一句「界面自动跟随浏览器语言（中/英）」 |
| `PRIVACY.en.md` | 新增，全译（国际区商店上架需要） |
| `PRIVACY.md` | 顶部加英文版链接 |
| `DESIGN.md` | §0「UI 语言」行改「中英双语（chrome.i18n，`_locales/en` + `zh_CN`，`default_locale=en`）」；§3.1 目录树加 `_locales/`；§6.7 文案收口节补双语装载说明；变更记录加 v1.5 条目 |
| `test/index.html` | 不动（纯内部测试页，中文保留） |
| `package.json` | 加 `check:locales` script；description 保持中文（内部开发脚本说明） |

### 4.10 布局与字体核查（英文更长）

英文文案普遍长于中文 30–80%，逐点核查结论：

| 约束点 | 现状 | 英文表现 | 结论 |
|--------|------|----------|------|
| 主页入口卡 `.entry-sub`（11px，两列 grid 各 ~170px） | 中文一行 | "Grab the visible area of the current tab" 折两行 | ✅ 卡片为纵向 flex，自然增高；主页总高仍远低于 popup 600px 上限，纳入双语视觉验收确认 |
| `.crop-actions button` `min-width: 120px` | — | "Scan full image" / "Scan selection" | ✅ 单行放下 |
| `#btn-retry-crop` `min-width: 160px` | — | "Retry with selection" | ✅ |
| 两步清空按钮翻转 `Clear → Clear all?` | 「清空 → 确认清空？」 | link-btn 无宽度约束 | ✅ |
| `flashBtn` 翻转 `Copy → Copied` | 「复制 → 已复制」 | 1.2s 定时恢复，宽度无约束 | ✅ |
| 字体栈 `"Segoe UI", "Microsoft YaHei"` | — | Segoe UI 覆盖拉丁字形 | ✅ 无需改；YaHei 兜底 CJK 不受影响 |
| badge `✕` | — | 符号语言中立 | ✅ 原样保留 |

唯一可能需要微调的是入口卡折行后的视觉密度，留到双语视觉验收阶段决定（预案：`.entry-sub` 英文下 `line-clamp` 不做，保持完整显示）。

---

## 5. 英文文案翻译全表（42 条）

zh_CN 列 = 现网文案原样搬运（零改动）；en 列已按 grill Q5 拍板定稿（保留 Windows 措辞，与中文版举例对称）。

### 头部

| key (snake) | zh_CN | en |
|---|---|---|
| `app_name` | QR2Link | QR2Link |
| `app_subtitle` | 二维码 → 链接 | QR code → link |

### 主页三入口

| key | zh_CN | en |
|---|---|---|
| `btn_screenshot` | 截取当前网页 | Capture current page |
| `btn_screenshot_sub` | 截取当前标签页可视区域 | Grab the visible area of the current tab |
| `btn_upload` | 上传图片 | Upload image |
| `btn_upload_sub` | 选择本地图片文件 | Pick a local image file |
| `btn_clipboard` | 读取剪贴板图片 | Read image from clipboard |
| `input_hint` | 支持 Ctrl+V 粘贴 · 也可拖拽图片到此窗口 | Paste with Ctrl+V · or drag an image into this window |
| `drop_here` | 松开以识别图片 | Drop image to scan |

### 预览 / 框选

| key | zh_CN | en |
|---|---|---|
| `crop_hint` | 在预览图中拖拽框选二维码区域（可选，不选则全图识别） | Drag on the preview to select a QR area (optional — the full image is scanned by default) |
| `btn_scan_full` | 全图识别 | Scan full image |
| `btn_scan_crop` | 识别所选区域 | Scan selection |
| `btn_back` | 返回 | Back |

### 状态 / 错误

| key | zh_CN | en |
|---|---|---|
| `decoding` | 识别中… | Scanning… |
| `err_no_qr_title` | 未识别到二维码 | No QR code found |
| `err_no_qr_hint` | 可框选二维码区域后重试，或更换更清晰的图片 | Try selecting the QR area, or use a clearer image |
| `err_capture_title` | 截图失败 | Screenshot failed |
| `err_capture_hint` | 当前页面可能不允许截图。请用系统截图（如 Win+Shift+S）后粘贴，或上传图片 | This page may not allow screenshots. Take a system screenshot (e.g. Win+Shift+S), then paste or upload it |
| `err_clipboard_no_image` | 剪贴板中没有图片 | No image in the clipboard |
| `err_clipboard_read` | 剪贴板读取失败 | Clipboard read failed |
| `err_clipboard_read_hint` | 请先点击弹窗内任意位置再试，或直接按 Ctrl+V | Click inside this popup first and retry, or just press Ctrl+V |
| `err_image_decode` | 图片无法读取 | Image could not be decoded |
| `err_fetch_image` | 图片获取失败（可能受跨域或网络限制） | Failed to fetch the image (possibly blocked by CORS or the network) |
| `btn_retry_crop` | 框选重试 | Retry with selection |

### 结果卡片

| key | zh_CN | en |
|---|---|---|
| `btn_open` | 打开 | Open |
| `btn_copy` | 复制 | Copy |
| `btn_keep` | 保留 | Keep |
| `copied` | 已复制 | Copied |
| `copy_failed` | 复制失败 | Copy failed |
| `kept` | 已保留 | Kept |
| `text_label` | 文本 | Text |

### 历史

| key | zh_CN | en |
|---|---|---|
| `history_title` | 最近识别 | Recent scans |
| `history_off` | 历史记录已关闭，开启后可保留识别结果 | History is off. Turn it on to keep scan results |
| `history_empty` | 暂无保留的记录 | No saved results yet |
| `history_clear` | 清空 | Clear |
| `history_clear_confirm` | 确认清空？ | Clear all? |
| `history_delete` | 删除 | Delete |

### 后台（右键菜单 / badge）

| key | zh_CN | en |
|---|---|---|
| `menu_scan_image` | 识别图中二维码 | Scan QR code in image |
| `badge_fail` | ✕ | ✕ |

### 新增（manifest 专用）

| key | zh_CN | en |
|---|---|---|
| `manifest_description` | 截图 / 上传 / 粘贴图片，本地识别二维码并打开网页链接 | Capture, upload, or paste an image to decode QR codes locally and open web links |
| `command_scan_description` | 截图并识别当前网页中的二维码 | Capture the current page and scan it for QR codes |

> 翻译取向：按钮用短动词短语（Open / Copy / Keep）；错误提示保留「原因 + 下一步动作」结构；`err_capture_hint` 的 Win+Shift+S 举例保留（目标平台 Chrome/Edge 桌面为主，Mac 用户由 "system screenshot" 语义覆盖）。

---

## 6. 测试与验收方案

### 6.1 自动化

| 层 | 内容 | 命令 |
|----|------|------|
| 静态（前置守门） | locale 完整性（key 奇偶/非空/引用闭包/manifest token），run-all 第一步自动执行 | `npm run check:locales` |
| e2e（中文回归） | 现有 A–N 全量用例，锁定 `--lang=zh-CN`，**chromium + msedge 双 channel** | `QR2LINK_E2E_LANG=zh-CN node test/e2e/run-all.cjs <channel>` |
| e2e（英文回归） | 同一全量套件，`--lang=en-US`，**仅 chromium**（grill Q4） | `QR2LINK_E2E_LANG=en-US node test/e2e/run-all.cjs chromium` |
| 新用例 | N1 manifest 描述已按语言解析；N2 `<html lang>` 一致性 | 随 run-all |

### 6.2 手动验收清单（两种语言各过一遍）

- [ ] `chrome://extensions` 扩展卡片描述为对应语言（manifest `__MSG_` 解析）
- [ ] popup 主页 / 预览框选 / 结果卡片 / 历史面板 / 各错误态文案正确且无截断溢出（重点：入口卡折行后视觉可接受）
- [ ] 右键图片菜单标题对应语言；改浏览器语言重启后菜单标题跟随更新（D1 决策验证）
- [ ] `chrome://extensions/shortcuts` 快捷键描述对应语言
- [ ] 英文下完整走通：截图→框选→识别→打开/复制/保留/清空历史
- [ ] 语言回落：`--lang=fr` 启动时界面为英文（default_locale=en 生效）
- [ ] 发版清单：`npm run check:locales` 通过（grill Q3）
- [ ] 重新打包 `node scripts/pack-zip.mjs`，解压 zip 加载验证（`_locales` 在包内）

---

## 7. 风险与边界

| # | 风险 | 概率/影响 | 对策 |
|---|------|-----------|------|
| R1 | **发布包漏 `_locales`** → manifest `__MSG_` 无法解析，Chrome 拒绝加载扩展（现网事故级） | 中 / 高 | pack-zip INCLUDE 补齐 + §6.2 末项「解压 zip 实加载」验收 + check-locales 校验包内容可后加 |
| R2 | 三处 key 清单漂移（en / zh_CN / i18n.js KEYS）导致漏译显示 key 名 | 中 / 低（有 `‖k` 兜底，UI 一眼可见） | `check:locales` 强校验，进 e2e 前置步骤 |
| R3 | 英文变长引发布局截断/换行异常 | 低 / 低 | §4.10 逐点预核 + 双语视觉验收 |
| R4 | **zh-TW / zh-HK 用户回落英文**：Chrome 扩展 locale 无裸 `zh`，zh-TW 无法经父语言命中 zh_CN，将直接落 `default_locale=en`。现网硬编码简中时这类用户看简体中文，改造后变英文——**属体验回退，非中性变化**（grill 审核修正原「低影响」定性；Q2 拍板接受） | 确定 / 中（限港台用户） | README 已知限制一行说明 + 开 GitHub issue 记录待办；后续补 `_locales/zh_TW`（zh_CN 繁化 + 术语校对，机制零改动，约 1–2h） |
| R5 | e2e 在英文系统宿主机上误按英文启动导致旧断言失败 | 中 / 中 | launch 默认强制 `--lang=zh-CN`，语言成为显式输入 |
| R6 | Chrome Web Store **商店 listing**（商店描述/截图）是另一套本地化系统 | — | 运营项：开发者后台手动维护中英 listing，源文案取自 README / PRIVACY 英文版，不在代码范围 |

---

## 8. 实施顺序与工作量

**前置（grill Q1 拍板）**：先合入 `feat/issue-1-multi-code-tiling` → 从 `main` 切出 `feat/i18n-bilingual`，两 feature 独立 PR。

| 步骤 | 内容 | 产出 | 预估 |
|------|------|------|------|
| 1 | `_locales` 两文件 + `i18n.js` 改造 + `manifest.json` | 核心双语切换可用 | 2h |
| 2 | popup.js lang 属性 + background.js onStartup 菜单 | 边缘修复 | 0.5h |
| 3 | `pack-zip.mjs` + `scripts/check-locales.mjs` + package.json script | 发布与守门 | 1h |
| 4 | e2e 改造（helpers lang/msg + run-all 断言 + N1/N2；**开工先跑 `--lang` 探针**，§4.8-4） | 双语回归能力 | 1.5h |
| 5 | 文档（README.en / PRIVACY.en / DESIGN 更新） | 国际用户文档 | 1.5h |
| 6 | 双语全量回归 + 手动验收清单 + 打包验证 | 验收通过 | 2h |

合计约 1 个工作日。步骤 1–3 完成即构成最小可交付（功能完整），4–6 为质量与发布配套。

---

## 9. 明确不做（非目标）

- ❌ 扩展内语言手动切换开关（跟随浏览器语言是 Chrome 生态惯例；本扩展无 options 页，保持零配置）
- ❌ `zh_TW` 繁体包（grill Q2 拍板：本期不补，接受港台用户回落英文；README 已知限制 + issue 待办。后续补入机制零改动，见 §7-R4）
- ❌ 中文以外的第三语言（机制就绪，加目录即可）
- ❌ `test/index.html` 测试页、代码注释、DESIGN.md 正文翻译（纯内部资产，保持中文）
- ❌ 商店 listing 本地化（运营后台操作，不在代码仓）

---

## 10. 审核记录（grill）

- **2026-11-05 第一轮**：owner 拍板 D1（`default_locale=en`）、D2（名称保持 QR2Link）、D3（tooltip 不动）、D4（文档独立英文文件）。
- **2026-11-05 第二轮 grill 审核**（基于事实核查）：
  - Q1 分支基线 = 先合 issue-1 再从 main 切（已拍板）
  - Q2 zh-TW 回落 = 本期不补、接受英文回退（已拍板；R4 定性由「低」升级为「中·体验回退」）
  - Q3 守门机制 = 本地 e2e 前置 + 发版清单，不建 CI（已拍板）
  - Q4 e2e 矩阵 = en 仅 chromium、zh 双 channel（已拍板）
  - Q5 翻译定稿 = 按 §5 建议稿定稿、保留 Windows 措辞；Q6 版本发布 = v1.1.0 随下个 Release（双语 release notes）（两项 owner 补充拍板 ✅）
- **审核查证事实**：Chrome 扩展合法 locale 仅 55 个且无裸 `zh`（zh-TW 无法父语言命中 zh_CN）；仓库无 CI 基建。

---

## 11. 实施记录（2026-11-05，PR #3）

### 验证结果

| 项 | 结果 |
|----|------|
| `npm run check:locales` | ✅ 42 key × 2 语言，引用闭包完整 |
| `--lang` 探针（probe-lang.cjs） | ✅ zh-CN→简中包 / en-US→英文包 / **fr→default 回落英文包（locale_lang=en）**，D1 与 locale_lang 设计三路实测符合预期 |
| e2e chromium × zh-CN | ✅ **69 / 69 通过**（含新增 A3b manifest 解析、B1 html lang） |
| e2e chromium × en-US | ✅ **69 / 69 通过**（全套用例英文环境完整回归，Q4 矩阵） |
| e2e msedge × zh-CN | ✅ **69 / 69 通过** |
| 打包 `pack-zip` | ✅ `dist/qr2link-v1.1.0.zip`（87.6 KB），zip 内 `_locales/{en,zh_CN}` 与 manifest 齐全 |

### 与计划的偏差（均为实施中细化，无方向性变化）

1. **新增内部 key `locale_lang`**（总 key 数 40→42 含 2 个 manifest 专用）：各语言包自描述 BCP47 标签，`applyI18n` 以它设 `<html lang>`。比计划稿的「`getUILanguage()` 正则判断」更准——fr/zh-TW 等 default 回落场景下 UI 实际是英文，正则会误标 zh/fr。
2. **N1/N2 未独立成套件**：N1 落位 A3b（紧贴 A3 菜单断言之后），N2 并入 B1 初始态断言——更贴近被测对象，报告仍可按名检索。
3. **报告文件名带语言后缀**（如 `chromium-en-US-*.md`），双语回归各自留档。
4. run-all 用例数 68→69（+A3b）。

### 交付物清单

`_locales/{en,zh_CN}/messages.json`（42 key）、`i18n.js`（getMessage 装配）、`manifest.json`（v1.1.0 / default_locale=en / __MSG_）、`popup.js`（html lang）、`background.js`（onStartup 菜单重建 + justification 英文化）、`pack-zip.mjs`（+_locales）、`scripts/check-locales.mjs` + `npm run check:locales`、`test/e2e/{helpers,run-all,probe-lang}.cjs`（双语回归）、`README.en.md` / `PRIVACY.en.md`（全译）+ 中英互链、`DESIGN.md` v1.7、本文件实施记录。

### PR #3「Review by AIbot」采纳记录（2026-11-05，review 基线 44851a9）

外部 AI review 三条意见（P2×2 + P3）经分析**全部采纳**，均为守门强化、零产品行为变化：

| 意见 | 采纳处置 |
|------|----------|
| P2：重复 key 检查依赖换行排版，同行/压缩形态漏检（`JSON.parse` 静默取后者） | `check-locales.mjs` 改用**字符串感知状态机**扫描原始文本（跟踪引号/转义/花括号深度，只认根对象成员名），与排版无关 |
| P2：引用闭包先按格式过滤——`data-i18n="btn_screenshot"` 类 snake 拼错被正则忽略而非拒绝；`runDecode` 计算 key 分支在扫描盲区 | ① data-i18n 改为**先收集任意格式取值、再对照 KEYS**；② `popup.js` `runDecode` 消灭计算 key（`T.errFetchImage`/`T.errImageDecode` 直接引用，落入静态扫描）；③ 计算式访问（`T[变量]`）实行**登记制**——仅允许 applyI18n 的 2 处（key 来源已被 4a 全量校验），新增必须登记 |
| P3：`default_locale` 只查字段存在，值指向不存在语言包仍退出 0 | 解析 manifest 后校验值必须有对应 `_locales/` 目录（读目录现查，不硬编码） |
| review 要求补失败用例 | 新增 `--self-test` 变异测试模式：6 个用例（同行重复 key / snake 绑定 / key 拼写 / 计算式访问 / default_locale 无语言包 / 正常基线）全部按预期捕获，**守门自身也被回归锁定** |

review 其余事项：「已接受不阻塞」各项与 Q1–Q6 拍板一致；其 macOS 环境 `--lang` 不生效属平台差异（Windows 宿主实测 zh-CN/en-US/fr 三路均正确翻转，且 3×69 双语矩阵在本仓证据充分），无需处置。

修复后验证：`check:locales` ✅ + `--self-test` 6/6 ✅ + e2e chromium×zh-CN **69/69** ✅（第 0 步同时实测新守门作为 run-all 前置）。

### 发布包缺陷修复：zip 条目反斜杠分隔符（2026-11-06，用户报告引发）

**现象**：用户反馈「英文界面按钮显示 btn_xxx」。全面排查（chromium/msedge × 仓库目录加载 / Windows 解压加载 / popup 页签，probe-en-ui.cjs 全量 dump + 截图）显示**英文 UI 实际渲染全部正确**——`data-i18n` 的 key（btnScreenshot 等）是内部标识符，按钮显示的是 messages.json 的文案。

**真正的 bug 在发布包**：`pack-zip` 用的 Windows PowerShell 5.1 `Compress-Archive` 以 **`\`** 作为 zip 条目名分隔符（实测 36/36 条目违反 zip 规范 §4.4.17 的 `/` 要求）。后果：

- **Chrome Web Store 直接拒收**（上传校验条目分隔符）；
- **严格解压工具**（Info-ZIP unzip / macOS 归档工具 / 部分 Linux 工具）会把 `_locales\en\messages.json` 解成带反斜杠的扁平文件名或丢弃 → `_locales` 缺失 → `chrome.i18n.getMessage` 全部返回空 → UI 回落显示原始 key 名（`i18n.js` 的 `‖k` 兜底）——**即用户所见症状的来源路径**（Windows 自带解压宽容处理不受影响，故此前未被发现）。

**修复与验证**（全部通过）：

1. `pack-zip.mjs` 改用 .NET `ZipArchive` 显式以 `/` 建条目（兼容 PS 5.1，不用 .NET Core 的 GetRelativePath）；
2. pack-zip 内置**打包后字节级自检**：扫描 local file header / central directory 名段，任何 `\` 即非零退出（防回归）；
3. 重打包实测：0 个反斜杠条目；**Info-ZIP unzip 严格解压**目录树正确 → 从解压目录加载扩展 → 英文文案全部正确解析（probe-zipflow.cjs 端到端）；
4. 新增 `test/e2e/probe-en-ui.cjs`（双语 UI 全表面探针 + 截图）与 `probe-zipflow.cjs`（发布包解压加载探针），作为发版前的例行验证项。

**遗留提示**：`_locales` 缺失时 Chrome 直接拒绝加载（模拟实验中启动即挂起）——坏包的症状是「装不上」而非「显示 key」；用户若曾见 raw key 界面，更可能是从混合/异常目录加载所致，重载修复后目录即可。
