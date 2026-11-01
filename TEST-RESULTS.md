# QR2Link 首轮验收实测记录（TEST-RESULTS）

> 日期：2026-11-01
> 方式：**Playwright 自动化验收**（`test/e2e/`，54 用例）+ 环境差异探针
> 对应：DESIGN.md §8 验证矩阵；本文是该矩阵的首轮实测回填
> 结论速览：**Edge 156 全套件 54/54 三轮稳定全绿；Playwright Chromium 交叉验证 41/41；未发现产品级 bug**；品牌版 Chrome 受 137+ 移除 `--load-extension` 限制，留人工清单（§6）

---

## 1. 执行环境

| 项 | 值 |
|---|---|
| 机器 | Windows 10 (10.0.19045) x64，Node 24.15，Playwright 1.62.1（全局） |
| 主环境 | **Microsoft Edge 156.0.4314.58（品牌版）** — 与 Chrome 同引擎同版本代 |
| 交叉环境 | Playwright Chromium（非品牌版，QR2Link 功能全部一致） |
| 品牌版 Chrome 156.0.8078.79 | **无法自动化加载扩展**（见 §6），留人工清单 |
| 解码引擎实测 | `BarcodeDetector in globalThis = false`（SW/popup 两端实测，Windows 桌面均无）→ **jsQR 为实际引擎**，与交接文档预判一致 |

**为什么主环境是 Edge 而不是 Chrome**：Chrome 137 起移除了品牌版的 `--load-extension` / `--disable-extensions-except` 命令行加载能力（实测 Chrome 156 稳定版确实忽略该 flag，chrome://extensions 列表为空）；Edge 156 品牌版仍支持，且引擎与 Chrome 156 同源。扩展逻辑层（解码管线/offscreen 通信/存储/UI）两通道实测行为完全一致。

## 2. 自动化结果总览

| 套件 | 用例数 | Edge 156 | Chromium |
|---|---|---|---|
| A：SW / offscreen / badge / 右键链路 / 协议白名单 | 13 | ✅ 13/13 | ✅（A3 菜单注册在本通道验证） |
| B：popup UI（上传/拖拽/剪贴板/框选/结果/历史/宽度） | 28 | ✅ 28/28 | ✅ 28/28 |
| C：截图主路径（OS 手势授权 activeTab → 真实截图 → 预览框选） | 5 | ✅ 5/5 | — |
| D：快捷键真实手势全链路 / 特殊页面矩阵 | 8 | ✅ 8/8 | — |
| **合计** | **54** | **54/54 × 3 轮稳定** | **41/41** |

明细报告（含每用例耗时与观察值）：`test/e2e/report/*.md`（本轮：msedge-2026-11-01T12-5*.md / chromium-2026-11-01T12-52-26.md）。

重跑方式：`cd test/e2e && NODE_PATH="$(npm root -g)" node run-all.cjs msedge [ABCD]`

## 3. DESIGN §8 矩阵逐项结论

### 3.1 功能主路径

| 项 | 结论 | 证据 |
|---|---|---|
| 截图→全图/框选识别→打开链接 | ✅ | C1–C5：OS 注入 Alt+Shift+S 授予 activeTab → 按钮真实 captureVisibleTab（68KB）→ 预览 + 宽度 760 → 全图/框选解码；B12 框选坐标换算（双码图取左码）正确 |
| 上传 png/jpg/webp + 拖拽 | ✅ | B2/B8/B22（拖拽经 DataTransfer 注入验证；OS 级拖拽未自动化） |
| 剪贴板双通道（按钮读 / Ctrl+V） | ✅ | B18（按钮通道）+ B19（**真实键盘 Ctrl+V** 事件触发 paste）均解码成功 |
| Alt+Shift+S 自动开首链 | ✅ | D1：测试页快捷键 → 截图 → offscreen 解码 → 自动开 `example.com/qr2link-*`（jsQR 单码引擎，7 码页任一均算通过） |
| 连按多次 offscreen 不重复创建 | ✅ | A6（并发 3 次）/ D2（实按 2 次）→ `getContexts()` 恒为 1 |
| 右键同源图识别 | ✅ | A11：offscreen fetch 同源 URL → 解码成功（ACAO 头模拟 activeTab 已授予来源） |
| 右键跨域图降级 badge ✕ | ✅ | A12：取图失败（ECONNREFUSED，与跨域拒绝同代码路径）→ ✕、不误开页；真实 CDN 观察值随网络环境不同（本机代理下 `Failed to fetch`） |
| 历史默认关→开→保留/打开/删除/清空 | ✅ | B1/B24–B28，含 storage 持久化、20 条上限、两步确认 3s 自动还原 |
| popup 宽度紧凑↔展开还原 | ✅ | B1（400）/B2（760）/B14（还原 400）/C5 |

### 3.2 引擎与解码边界

| 项 | 结论 | 证据 |
|---|---|---|
| `canUseNativeQr()` 实测 | `false`（Windows 桌面无 BarcodeDetector） | A2 |
| 原生 detect 异常降级 | 不适用（本环境无原生引擎；代码路径 try/catch 已静态审查） | — |
| 一图两码 | **jsQR 环境整体 miss（实测复现交接文档 §3）** → 明确报错 + 框选重试可用 | B11 |
| 大图小码 8000×5000 阶段 2 | ✅ 上传路径（B9，~2.3s）与 offscreen URL 路径（A10）均命中 | |
| 反色码 | ✅ B7 | |
| 120px 小码 | ✅ B6 | |
| URL 前后空格 trim | ✅ B10（结果文本已 trim、出现「打开」） | |
| 无码图明确报错 | ✅ B13 路径 + C3 | |
| 低对比度/旋转/透视变形码 | ⚠️ 未覆盖（无样例资产，建议 gen-qr.mjs 补充后加入 B 组） | |

### 3.3 剪贴板边界

| 项 | 结论 | 证据 |
|---|---|---|
| 纯文本剪贴板 →「剪贴板中没有图片」 | ✅ 按钮通道（B17）与 Ctrl+V 通道（B20）行为一致 | |
| 文本+图片混合只取图 | ✅ B21 | |
| popup 失焦后 Ctrl+V | ⚠️ 未直接自动化（tab 模式下失焦语义与真实 popup 不同）；popup.js 的失败分支（`errClipboardRead` 引导手动 Ctrl+V）已静态确认存在，留人工项 §6 | |
| 超大剪贴板图 | ⚠️ 未覆盖 | |

### 3.4 特殊页面可截性（Edge 156 实测，OS 真实手势）

| 页面 | captureVisibleTab | badge | 备注 |
|---|---|---|---|
| edge://settings | ✅（~207KB） | ✕（无码） | 可截 |
| edge://extensions | ✅（~119KB） | ✕ | 可截 |
| 内置 PDF 查看器 | **两轮结果不同**：一轮 ✅（~15KB）、一轮 ❌ `Cannot access contents...` | ✕ 优雅降级 | 插件文档加载时序影响；无论可截与否均不崩溃、有引导 |
| Chrome Web Store | ❌ `Cannot access contents of the page...` | ✕ 优雅降级 | 受保护页，符合预期 |
| 其他扩展页（popup.html） | ✅ | ✕ | 可截 |

> 结论：失败页面统一走「截图失败 + 引导粘贴/上传」文案（B23 验证了无手势失败分支的引导内容），**无 hard fail**。

### 3.5 安全（DESIGN §8 安全项）

| 项 | 结论 |
|---|---|
| `javascript:` / `data:` / `file:` / 纯文本 | ✅ A13：`parseHttpUrl` 全部拒绝；B5 非 URL 文本仅展示+复制无「打开」 |
| 渲染一律 textContent | ✅ 静态审查（交接文档 §2）+ B 组运行无注入面 |
| 「复制」之外无剪贴板写入 | ✅ B4（复制按钮写入内容精确匹配）；全仓 grep 已核对 |

## 4. 浏览器差异与平台发现（新）

1. **Edge 156 的 `chrome.action.getBadgeText()` resolve 裸字符串**（而非文档的 `{text}` 详情对象）——扩展自身未调用此 API，不受影响；测试侧已做双形态兼容。
2. **Edge 156 的 `chrome.contextMenus` 无 `getAll()`**（有 create/remove/removeAll/update）——扩展只用 removeAll+create，不受影响；菜单注册改在 Chromium 通道验证通过（A3：`qr2link-scan-image`，contexts=image，标题正确）。
3. **本机网络下 `example.com` 直连被黑洞挂起**（TCP 永不返回），自动化用 `--host-resolver-rules` + 本机自签 https 落地解决；不影响产品。

## 5. 已知问题与改进建议（不属 bug，留给用户定夺）

1. **右键取图无超时**：`qr.js sourceToBlob` 的 `fetch` 无 AbortController；目标网络黑洞时用户长时间无任何反馈（badge 迟迟不出现）。建议加 ~10s 超时转「取图失败」降级。**是否加，请定夺**（涉及设计偏离，未擅自改）。
2. **多码象限分块是否提级**：本轮再次实证 Windows 桌面（无 BarcodeDetector）下 jsQR 对多码图整体 miss；当前恢复路径「框选重试」实测有效（B12）。若常看多码图（如同时贴两个码的聊天截图），建议提级；否则维持 backlog。
3. **badge ✕ 定时器互相覆盖**：连续两次失败时，前一次的 3s 清除定时器会清掉后一次刚设置的 ✕（设计已声明可接受，实测确认存在；体感影响极小）。
4. **badge 颜色从不还原**：设置红色后保持红色直到下次设置（设计已知项，实测无突兀感，维持现状）。

## 6. 品牌版 Chrome 人工验收清单（自动化不可行，≈10 分钟）

Chrome 137+ 移除了命令行加载扩展能力，以下请在品牌版 Chrome 手工过一遍（引擎与 Edge 156 同源，预期全部一致）：

- [ ] `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `D:\Vibing\qr2link`，SW 可点开、无报错
- [ ] 三入口主路径：截图（test/index.html）→ 框选识别 → 打开；上传 png；Ctrl+V 粘贴 Win+Shift+S 截图
- [ ] Alt+Shift+S 直扫自动开首链；连按两次无异常
- [ ] 右键同源图识别；右键跨域图（测试页百度图）badge ✕
- [ ] `chrome://settings`、PDF、Web Store 各试一次截图按钮 → 失败应有引导文案
- [ ] popup 失焦后按 Ctrl+V 的实际表现（对比 B19 的聚焦行为）
- [ ] `chrome.action.getBadgeText` 若需调试，注意 Chrome 与 Edge 返回形态可能不同（§4.1）

## 7. DoD 回填（交接文档 §8）

- [x] DESIGN §8 矩阵全部执行并记录（可自动化范围；未覆盖项已逐条标注 ⚠️）
- [x] Edge 主路径 + 逐 API 抽查记录（offscreen/commands/contextMenus/BarcodeDetector/clipboard.read 全部有实测数据）
- [x] 发现的 bug：**产品代码 0 个**（全部 54 用例通过；调试期问题均出自测试脚手架自身，过程沉淀在 harness 注释与 report/）
- [x] 多码处置决策：实测数据已留痕，提级与否待用户定夺（§5.2）
