# QR2Link 验收实测记录（TEST-RESULTS）

> **当前结论（迭代四·PR-2，2026-11-14，唯一有效口径）**
> 方式：**Playwright 自动化验收**（`test/e2e/`，108 用例 = 84 存量 + 24 新增 F/G 组）
> 对应：DESIGN.md §8 验证矩阵；V1.2-PLAN PR-2（C1 结构化解析 + C2 安全预检，见 §10.5；PR-1 见 §10.1–10.4）
> 结论速览：**四轮全绿 108/108 ×4（Edge 156 / Playwright Chromium × zh-CN / en-US）**；新增锁定：WIFI/otpauth/vCard/tel/sms/mailto/geo 解析正负矩阵、TOTP RFC 6238 官方向量 ×12（SHA1/256/512）、倒计时与视图切换清理、安全分级/reasons 排序、danger 两段式确认、快捷键 danger 照开（拍板③）+ SW 无 Safety 全局
>
> 历史迭代：迭代一（54/54，§1–§7）、迭代二（62/62，§8）、迭代三（68/68，§9）仅作过程留痕，**用例计数以本节为准**。

---

## 1. 执行环境（迭代一，2026-11-01）

| 项 | 值 |
|---|---|
| 机器 | Windows 10 (10.0.19045) x64，Node 24.15，Playwright 1.62.1（全局） |
| 主环境 | **Microsoft Edge 156.0.4314.58（品牌版）** — 与 Chrome 同引擎同版本代 |
| 交叉环境 | Playwright Chromium（非品牌版，QR2Link 功能全部一致） |
| 品牌版 Chrome 156.0.8078.79 | **无法自动化加载扩展**（见 §6），留人工清单 |
| 解码引擎实测 | `BarcodeDetector in globalThis = false`（SW/popup 两端实测，Windows 桌面均无）→ **jsQR 为实际引擎**，与交接文档预判一致 |

**为什么主环境是 Edge 而不是 Chrome**：Chrome 137 起移除了品牌版的 `--load-extension` / `--disable-extensions-except` 命令行加载能力（实测 Chrome 156 稳定版确实忽略该 flag，chrome://extensions 列表为空）；Edge 156 品牌版仍支持，且引擎与 Chrome 156 同源。扩展逻辑层（解码管线/offscreen 通信/存储/UI）两通道实测行为完全一致。

## 2. 自动化结果总览（迭代一历史口径，54 用例；当前迭代见顶部与 §9.4）

| 套件 | 用例数 | Edge 156 | Chromium |
|---|---|---|---|
| A：SW / offscreen / badge / 右键链路 / 协议白名单 | 13 | ✅ 13/13 | ✅（A3 菜单注册在本通道验证） |
| B：popup UI（上传/拖拽/剪贴板/框选/结果/历史/宽度） | 28 | ✅ 28/28 | ✅ 28/28 |
| C：截图主路径（OS 手势授权 activeTab → 真实截图 → 预览框选） | 5 | ✅ 5/5 | — |
| D：快捷键真实手势全链路 / 特殊页面矩阵 | 8 | ✅ 8/8 | — |
| **合计** | **54** | **54/54 × 3 轮稳定** | **41/41** |

明细报告（含每用例耗时与观察值）：`test/e2e/report/*.md`（本轮：msedge-2026-11-01T12-5*.md / chromium-2026-11-01T12-52-26.md）。

重跑方式：`cd test/e2e && NODE_PATH="$(npm root -g)" node run-all.cjs msedge [ABCD]`

## 3. DESIGN §8 矩阵逐项结论（迭代一实测；多码行为已被迭代二 §8 修订）

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

1. ~~**右键取图无超时**~~ → **已修复（v1.3，用户确认）**：`qr.js sourceToBlob` 的 `fetch` 增加 10s AbortController 超时，超时/网络失败/非 2xx 统一按「取图失败」降级（popup 沿用既有文案，SW 端 badge ✕），DESIGN §5.2 与变更记录已同步。
2. ~~**多码象限分块是否提级**~~ → **已实现（v1.5，issue #1）**：阶段 3 象限分块重扫落地，双码/四角四码实测救回，见 §8；「框选重试」恢复路径保留兜底。
3. ~~**badge ✕ 定时器互相覆盖**~~ → **已修复（v1.4，外部 review 采纳）**：flashFail 持有单一清除定时器，新一轮设置先清旧定时器。
4. **badge 颜色从不还原**：设置红色后保持红色直到下次设置（设计已知项，实测无突兀感，维持现状；review 建议还原背景色被驳回——Chrome 无法还原到真正的默认色，且清空文本后颜色不可见）。

## 6. 品牌版 Chrome 人工验收清单（✅ 已完成，2026-11-01 用户实测「目前看没什么问题」）

Chrome 137+ 移除了命令行加载扩展能力，以下为品牌版 Chrome 手工验收项（引擎与 Edge 156 同源）：

- [x] `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `D:\Vibing\qr2link`，SW 可点开、无报错
- [x] 三入口主路径：截图（test/index.html）→ 框选识别 → 打开；上传 png；Ctrl+V 粘贴 Win+Shift+S 截图
- [x] Alt+Shift+S 直扫自动开首链；连按两次无异常
- [x] 右键同源图识别；右键跨域图（测试页百度图）badge ✕
- [x] `chrome://settings`、PDF、Web Store 各试一次截图按钮 → 失败应有引导文案
- [x] popup 失焦后按 Ctrl+V 的实际表现（对比 B19 的聚焦行为）
- [x] `chrome.action.getBadgeText` 若需调试，注意 Chrome 与 Edge 返回形态可能不同（§4.1）

> 至此 DESIGN §8 矩阵在 Chrome / Edge 双品牌浏览器上全部闭环；结论升级为「**首轮验收通过**」。

## 7. DoD 回填（交接文档 §8，迭代一当期口径）

- [x] DESIGN §8 矩阵全部执行并记录（可自动化范围；未覆盖项已逐条标注 ⚠️）
- [x] Edge 主路径 + 逐 API 抽查记录（offscreen/commands/contextMenus/BarcodeDetector/clipboard.read 全部有实测数据）
- [x] 发现的 bug：**产品代码 0 个**（全部 54 用例通过；调试期问题均出自测试脚手架自身，过程沉淀在 harness 注释与 report/）
- [x] 多码处置决策：实测数据已留痕，提级与否待用户定夺（§5.2）

---

## 8. 迭代二：多码象限分块（issue #1，2026-11-01）

> 对应 issue #1「多码图支持」后续迭代方向第一项；DESIGN v1.5。

### 8.1 实现

- `qr.js` 新增**阶段 3 象限分块重扫**：阶段 2 仍无结果时，按几何梯子 **1×2 / 2×1 / 2×2 / 4×4** 逐块重跑「原生 → jsQR」引擎序列，全部扫完合并、由既有去重收口
- 梯子含单轴切分的原因（实测）：**纯 2×2 会把近满幅的并排/堆叠双码拦腰切断**——two-codes.png（640×340，码高 300px 跨水平中线）在 2×2 下四块全 miss，1×2 / 2×1 才能救回
- 预算护栏：rect ≤ 9MP（4K 截图 ≈ 8.3MP）逐块全分辨率；9MP–50MP 按阶段 1 档位（≤2000px）分块；**超 50MP 不进入阶段 3**（阶段 2 未执行 → 维持 review #3「框选重试」契约，B33 保持锁定）。最坏全 miss 耗时有界（5.6MP 图全梯子 ≈ 2.2s / 9MP ≈ 4s），不给 offscreen 消息链 15s 超时添险
- 已知边界（写入 DESIGN §2.1 / §3.3）：jsQR 全图已解出 ≥1 码时不分块（无法廉价区分「仅此一码」与「多码漏网其一」）；极端布局（3 列均布、密集骑缝码）仍 miss → 框选重试

### 8.2 实测（Playwright，用例 54 → 62）

| 项 | 结论 | 证据 |
|---|---|---|
| 并排双码（two-codes.png）整图 miss 复现 | ✅ 复现（Node 直扫 null） | bench |
| 并排双码 → 阶段 3 救回，2 张卡片 | ✅ Edge 217ms / Chromium 189ms | B11（重写）、A14（offscreen 链路同 2 条） |
| 四角四码 → 4 张卡片（2×2 梯级） | ✅ ~400ms | B34（新增） |
| 上下堆叠双码 → 2 张卡片（1×2 梯级） | ✅ | Node 梯子原型 + 浏览器集成验证 |
| 40MP 同文双码 → 恰 1 张卡片（>9MP 档位 / 阶段 2 子集边界） | ✅ 3.0s | B35（新增） |
| 框选重试换载体：超预算大图圈右下角小码 → rect 换算正确、crop 绕过 50MP 预算 | ✅ 1.8s | B12（重写，原双码载体因 B11 救回不再报错） |
| 60MP 超预算单码仍 miss（B33 契约不破） | ✅ 365ms | B33 |
| 无码图 / 截图主路径 / 快捷键 / 特殊页时序不受阶段 3 影响 | ✅ | C1–C5、D1–D4 全绿 |
| **合计** | **Edge 62/62 ×1 轮 + Chromium 49/49（A/B 交叉）** | report/msedge-2026-11-01T16-0*.md |

### 8.3 遗留（不随本版处理）

- jsQR「子集返回」（全图解出其一）场景的漏网码：可后续评估「命中码掩码重扫」（jsQR `code.location` 可得定位框）或区域分割预处理（issue 备选第二项）
- 3 列均布网格等极端布局：4×4 梯子覆盖不到，框选重试兜底；必要时再评估 zxing-wasm 多码模式（issue 备选第三项，代价是包体积）

---

## 9. 迭代三：PR #2 外部 review 处置（2026-11-05）

> review 来源：PR #2「Review by AIbot」评论（1 条 P1 + 2 条 P2）；对应 DESIGN v1.6。

### 9.1 P1 —— 阶段 3 最坏扫描耗时不具跨设备上界（采纳，含量级修正）

- **量级修正后采纳**：review 称 24 个 tile pass 在 9MP 下「累计 ≈216MP / 864MB RGBA」，经核查系按「每个 tile 处理全图面积」误算——`gridTiles` 每块仅覆盖 rect/(c×r)，每趟网格累计处理量 ≈ rect 面积，全梯子 ≈ **4×rect（9MP 时约 36MP / 144MB 累计读取）**，与实测 ~4s 吻合。但其核心结论成立：**像素预算只约束扫描量，无法跨设备换算为耗时上界，单机实测不构成证明**。
- **修复（qr.js）**：新增 `RESCAN_BUDGET_MS = 8000`——自阶段 2 起算的墙钟预算，阶段 3 逐 tile 检查 `performance.now()`，超时即截停剩余趟次（趟次按已验证价值排序：单轴 / 2×2 在前，4×4 投机趟次殿后），已扫部分照常合并返回；阶段 2 单趟不可中断（其上界仍是 50MP 像素预算）。取 8s 的拆账：15s 消息超时 − 取图余量（右键 URL 源最多 ~5s）− 解码/阶段 1/通信 ~1s − 截停超弛（截停检查在 tile 开工前，最后一个已开工 tile 须跑完）。
- **回归用例**：A15——9MP 调色板噪声图（高频过渡，比纯白与真实照片都悲观：纯白 jsQR ~40ms/MP 快速早退、噪声 ~480ms/MP；全梯子无截停 Node 实测 ≈17s）经 offscreen URL 链路全 miss，断言 0 结果且 <15s；B37——断言 9MP 白底全梯子 `stage3DeadlineCut=false`（防预算误伤正常路径）。

### 9.2 P2 —— 堆叠双码缺可重复 E2E 断言（采纳）

- 新增 **B36**：运行时生成 640×640 上下堆叠双码（几何对称于 two-codes.png：码 300px 近满幅、水平中线落在两码间隙），断言 2 张卡片且 top/bottom 文本齐全——1×2 梯级（单轴水平切分）自此有可重复的浏览器回归。
- 前置原型验证（Node + jsQR 直扫）：整图 null（整体 miss 复现）；1×2 上/下半各解出一码。

### 9.3 P2 —— 阶段选择边界缺回归用例（采纳，经测试探针）

- review 要求 9MP / 9MP+1px / 50MP / 50MP+1px 边界用例。阶段选择无法从解码结果稳定反推（9MP 档位两侧行为无差异），qr.js 新增 `QR2Link.getLastDecodeStats()` 诊断探针：阶段序列 / stage3 分辨率档 / 执行趟数 / 截停标志（串行诊断约定，产品逻辑不依赖此对象）。
- **B37–B40**：恰 9MP（3000×3000）→ 阶段 1→2→3、逐块全分辨率、4 趟全跑；9MP+300px（3000×3001）→ 切换 ≤2000px 降采样档；恰 50MP（8000×6250）→ 阶段 2/3 仍执行（预算为闭区间）；50MP+8px（8000×6251）→ 仅阶段 1（B33 契约的边界点锁定）。

### 9.4 P2 —— 验收文档口径不一致（采纳）

- 顶部改为当前迭代唯一总览；§1–§3、§7 标注迭代一历史口径；§8（迭代二）保留留痕；README 用例数同步 62 → 68。
- 各迭代报告 ↔ 代码态对应关系（报告文件均在 `test/e2e/report/`，已 gitignore，以文件名留痕）：

| 迭代 | 用例口径 | Edge 156 | Chromium | 报告文件 | 对应代码态 |
|---|---|---|---|---|---|
| 一（2026-11-01） | 54 | 54/54 ×3 轮 | 41/41 | msedge-2026-11-01T12-5*.md、chromium-2026-11-01T12-52-26.md | 首轮验收（先于 1631c01 扩充注入用例至 59） |
| 二（2026-11-01） | 62 | 62/62 | 49/49 | msedge-2026-11-01T16-05-13 / 16-06-14.md | 1b2964c |
| 三（2026-11-05） | 68 | 68/68 | 55/55（A/B） | msedge-2026-11-05T10-48-32.md（全量）、chromium-2026-11-05T10-50-02.md（A/B） | 本迭代提交（review #2 处置，见 git log） |

### 9.5 实测（迭代三）

| 项 | 结论 | 证据 |
|---|---|---|
| 最坏全 miss（9MP 高频纹理，全梯子无截停 ≈17s）→ 预算截停、链路不超时 | ✅ 11.9s < 15s，0 结果 | A15（新增） |
| 9MP 白底全梯子不被预算误伤 | ✅ ~2.7s，deadlineCut=false | B37（新增） |
| 堆叠双码 → 2 张卡片（1×2 梯级） | ✅ ~240ms | B36（新增） |
| 恰 9MP / 9MP+300px 档位翻转 | ✅ 全分辨率 ↔ 降采样 | B37/B38（新增） |
| 恰 50MP / 50MP+8px 预算闭区间 | ✅ 执行 ↔ 跳过 | B39/B40（新增） |
| 既有 62 用例无回归 | ✅ 全绿 | A1–A14、B1–B35、C1–C5、D1–D4 |

### 9.6 遗留（不随本版处理）

- 预算截停对「慢设备上大型合法多码图」的召回损失：截停时已扫部分照常返回，未扫趟次落「框选重试」——与 review 建议的分层执行一致，属有意取舍（DESIGN §9 风险表）。
- 取图耗时 + 重扫预算的叠加边界（如 ~9s 慢取图成功后 + 8s 重扫 > 15s 消息超时 → badge ✕）：属 v1.4 既定 15s/10s 拆账下的已知极端组合，预算已将其从「无界」收窄为「至多超标一个截停超弛」，彻底解决需把绝对截止时刻穿透到 offscreen 消息协议，不随本版处理。

## 10. 迭代四：zxing 引擎升级 + 全码制（V1.2-PLAN PR-1，2026-11-14）

### 10.1 变更摘要

- vendor zxing-wasm **3.1.6**（`lib/zxing-reader.js` 38KB IIFE + `lib/zxing_reader.wasm` 946KB；`scripts/vendor-sync.mjs` 全文件 SHA256 锁定 + 来源记录；THIRD_PARTY_LICENSES 补 zxing-wasm-MIT / zxing-cpp-Apache-2.0）
- manifest 增 `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`（Chromium 103+ 要求显式声明；wasm 随包本地加载，见 E7）
- qr.js 引擎链分档：**阶段 1** native→zxing→（空）jsQR 三引擎全跑；**阶段 2** ≤20MP native→zxing、20–50MP 维持 native→jsQR（`STAGE2_ZXING_MAX_PIXELS=20MP`，按基准定档）；**阶段 3 梯子维持 jsQR 原样**（issue #1 多码救回机制）；结果对象加 `format` 字段（zxing canonical 名）；stats 探针加 `zxingBroken` / `stage2Engine`
- 全码制（拍板⑧）：zxing formats 留空；popup 结果 meta 对非 QR 码制前缀展示码制名（如「EAN13 · …」）

### 10.2 性能基准（`scripts/bench-zxing.mjs`，参考机，node 直调 wasm；结果存 `test/out/bench/bench-result.json`）

| 场景 | zxing 稳态 | jsQR 基线（v1.1 行为） |
|---|---|---|
| 320px 正常码 | 7ms | — |
| 9MP 无码噪声 | 1.65s | 29.0s（attemptBoth） |
| 20MP 无码 | 3.7s | — |
| 30MP 无码 | 6.0s ❌ | — |
| 50MP 无码 | 11.7s ❌ | 分钟级（未完成） |
| 40MP 大图小码 | 1.1s（命中早退） | 1.2s（命中早退） |

- 验收线「50MP 无码 ≤5s」**不达标** → 启用 V1.2-PLAN 预案①：zxing 阶段 2 定档 20MP；20–50MP 维持 jsQR（行为零变化），无码最坏链路整体不劣于 v1.1
- 浏览器侧 wasm 首实例化实测 **13–17ms**（node 侧 ~49s 为 node ESM/wasi 特性，不复现于浏览器；E8 用例锁定 <10s 门）

### 10.3 实测结论（四轮全绿 79/79 ×4：msedge/chromium × zh-CN/en-US）

| 项 | 结论 | 证据 |
|---|---|---|
| 全码制 11 种矩阵（QR/EAN13/UPCA/Code128/Code39/Code93/ITF/Codabar/DataMatrix/Aztec/PDF417）文本+format 锁定 | ✅ 逐一通过；**UPCA 按 zxing 语义记 EAN13 前置 0**（036000291452→0036000291452，数字等效） | E2 |
| UI 展示码制名 | ✅ meta 前缀「EAN13 · …」 | E3 |
| zxing 整图多码（不再依赖阶段 3 梯子） | ✅ two-codes / four-corners 均 stats.stages='1' | E4 |
| fallback 三态：健康空结果→阶段 1 jsQR 救回 / 阶段 2 不回落 jsQR（防双引擎叠加）/ 运行期异常→zxingBroken 置位接管 | ✅ | E5 / E5b / E5c |
| 阶段 2 引擎分档边界（恰 20MP ↔ 20MP+1px） | ✅ stage2Engine zxing ↔ jsqr | E6 |
| 离线零外联（setOffline 解码成功 + performance entries 无 http(s)） | ✅ wasm 无 CDN 依赖 | E7 |
| 存量引擎断言更新（A4/B5/B30–B32 jsqr→zxing）与 B11/B34/B36 梯级口径 | ✅ 全绿 | A/B 组 |
| 既有契约不回归：最坏 9MP 链路 ≤15s（A15 实测 12.7–13.6s）、9MP/50MP 阈值（B37–B40）、超 50MP 框选重试（B33） | ✅ 全绿 | A15、B33–B40 |

### 10.4 PR #4 AIbot review 处置（2026-11-14，全部采纳 9 项，无驳回；详见 V1.2-PLAN「PR #4 AIbot review 处置」）

| Review 点 | 处置 | 证据 |
|---|---|---|
| P1-1 native 命中短路 zxing → 混合码漏结果 | **代码修复**：native+zxing 合并去重（不短路）；>20MP 混合码边界记入已接受限制 | E9（注入原生命中 + QR+Code128 混合图 → 双结果） |
| P1-2a 20MP 无运行时硬上限 | 浏览器端全链路 <8s 门禁 + 已接受风险（wasm 单趟不可中断；v1.1 jsQR@9MP=29s 更差） | E10（实测 ~3.2s） |
| P1-2b bench FAIL 仍退 0 | 20MP 生产档退出码门禁；50MP 改「预期出档」信息行 | `scripts/bench-zxing.mjs` |
| P2-3 stage2Engine 记错值 | pass 完成后按实际引擎赋值（zxingBroken → jsqr） | E6b |
| P2-4 初始化失败未覆盖 | prepareZXingModule 抛错注入：jsQR 接管、只初始化一次、不 reject | E5d |
| P2-5 E7 非冷启动 / offscreen 无 1D | E7 改全新文档冷启动离线 + fetch/XHR 拦截断言 wasm 取自 chrome-extension://；E7b offscreen 1D 链路 | E7、E7b |
| P2-6 vendor 校验非门禁 | `npm run check:vendor` + run-all 前置守门（verify 仅读 lib/ 不依赖 node_modules） | run-all step 0 |
| P3-8 引擎描述不一致 | V1.2-PLAN 引擎分档段重写（阶段 3 为 native→jsQR） | V1.2-PLAN |
| P3-9 许可证 EOF 空行 | 清理 | git diff --check 干净 |

E 组 10 → 15（+E5d/E6b/E7b/E9/E10），全量 79 → 84，四轮全绿 84/84 ×4。

### 10.5 迭代四·PR-2：结构化解析 + 安全预检（V1.2-PLAN PR-2，2026-11-14）

#### 变更摘要

- 新增 `parsers.js`（全局 `Parsers`，仅 popup.html 引入）：WIFI 转义解析、otpauth TOTP **本地生成**（WebCrypto HMAC + RFC 6238，hotp 仅展示）、vCard（折叠行/多值/TYPE 参数剥离 + 下载 .vcf）、tel/sms/smsto/mailto/geo 语义卡片（仅复制不打开）；防御上限（≤4096 字符、WIFI ≤16 字段/256、vCard ≤100 行/512），失败一律 null 回落纯文本卡片；`maskSecrets()` 提供 otpauth secret= 显示层打码（存储/复制保持原文）
- 新增 `safety.js`（全局 `Safety`，仅 popup.html 引入）：纯本地启发式 `assessUrl → {level, reasons}`；danger = punycode 混排（内嵌 RFC 3492 解码器）+ `user:pass@`；caution = http 明文 / IP 字面量（IPv4/IPv6/IPv4-mapped 统一归单一原因）/ 短链域名表（15 域，文件顶部常量）；reasons 按 danger 先于 caution、规则枚举序稳定输出
- popup.js：结果文本下追加结构化卡片（全 textContent）、TOTP 动态码 + 每秒倒计时（重渲染/离开结果视图即清理 interval）、URL 卡片安全指示条（绿/黄/红 + 可展开原因）、**danger 级打开两段式确认**（复用 history-clear 3s 解除模式，拍板⑦）、结果原文与历史行 otpauth secret 显示层打码（历史行带「显示」切换）
- background.js：**零行为改动**，仅加 openFirstLink 不接 Safety 的防合并注释（拍板③）；pack-zip INCLUDE 补 `parsers.js`/`safety.js`；PRIVACY ×2「识别历史」条目明示 otpauth secret 原文存储 + 界面打码（review P1）
- i18n：49 新 key ×2 locales（91 key 总量）；reasons 文案经直接引用 map 渲染（`SAFETY_REASONS`），**未新增 computed `T[key]` 访问点**，check-locales 的 COMPUTED_ACCESS_ALLOWLIST 维持 2 不变（比方案原议的「computed + 上调计数」更强的静态可校验形态）

#### 实测结论（四轮全绿 108/108 ×4：msedge/chromium × zh-CN/en-US）

| 项 | 结论 | 证据 |
|---|---|---|
| WIFI 解析：四种转义 `\; \, \: \\`、nopass、小写前缀宽容、重复字段后值覆盖 | ✅ | F1 |
| WIFI 负面：缺 S/空 SSID/非法 T/非法 H/超长/字段数超限/悬空反斜杠 → null | ✅ 全部拒绝 | F2 |
| otpauth 解析：label issuer/account、digits/period/algorithm 默认值、secret 大小写与内嵌空白归一、hotp counter 默认 0 | ✅ | F3 |
| **TOTP RFC 6238 Appendix B 官方向量**（SHA1/SHA256/SHA512 各算法 seed ×12 个时刻，8 位）+ 6 位取模 | ✅ 浏览器 WebCrypto 全部命中 | F4 |
| TOTP 时间边界（跨窗换码/同窗同码）与 totpRemaining 纯函数 | ✅ | F5 |
| otpauth 负面：非法 Base32 字符/尾位组合、缺 secret、digits 5/9、period 0/3601、algorithm MD5、非法 type → null | ✅ | F6 |
| vCard：折叠行（RFC 6350 §3.2 语义）、多值 TEL/EMAIL、`;TYPE=` 参数剥离、值反转义、raw 原文保留 | ✅ | F7 |
| vCard 负面：缺 BEGIN/END、无可展示字段、超行数 → null | ✅ | F8 |
| tel/sms/smsto/mailto/geo 正负矩阵（%XX 解码、geo 越界、smsto 逗号形态等） | ✅ | F9/F9b |
| 超长输入（>4096）拒绝；maskSecrets 仅替换 secret 值 | ✅ | F10 |
| UI：WIFI 卡片字段还原 + 复制密码（还原后明文）写剪贴板 | ✅ | F11 |
| UI：otpauth 卡片动态码 6 位 + 倒计时 Ns + secret 打码/显示切换；**结果原文显示层打码、复制取原文** | ✅ | F12 |
| UI：历史行 otpauth 打码 + 显示切换；storage 与复制保持原文 | ✅ | F13 |
| UI：vCard 字段卡片 + 下载锚点（data:URI + download 属性）；**恶意 FN 以纯文本原样渲染、onerror 不执行** | ✅ | F14 |
| UI：geo 仅复制不打开；HOTP 仅参数展示无动态码 | ✅ | F15/F16 |
| TOTP 倒计时随视图切换清理（interval 拦截探针，无泄漏） | ✅ | F17 |
| 安全分级矩阵与 reasons 排序（danger 先于 caution、枚举序、多命中组合） | ✅ | G1 |
| punycode 边界：纯汉字/纯西里尔/拉丁变音符 IDN 不误报；畸形 xn-- 标签静默跳过 | ✅ 方案口径已知边界（纯单码制仿冒词不检测） | G2 |
| UI 分级指示条（ok/caution/danger 三色）+ 原因列表 i18n 文案与顺序 | ✅ 双语 | G3 |
| danger 两段式确认：首击翻转→未确认 3s 还原→确认打开；caution 一键直开 | ✅ | G4/G5 |
| **拍板③防回归：快捷键路径 danger URL 照常自动打开 + SW 中无 Safety 全局** | ✅ | G6 |
| 存量 84 用例（A–E）零回归 | ✅ 四轮 | 全量 |

#### 实现注记（供后续 PR 参考）

- **RFC 6238 Appendix B 的 SHA-256/SHA-512 向量以勘误 2866 的分算法 seed 复现**（t=59 SHA256=46119246 / SHA512=90693936）；开发中曾按错误记忆的期望值（46119282/90693946）误判实现有 bug，经 node:crypto 交叉验证 + RFC 原文核对确认实现正确，期望值已修正
- Base32 尾位合法性：合法无填充长度（字符数 mod 8 ∈ {0,2,4,5,7}）解码残位 ∈ 0–4，残位 >4 拒绝（F6 的 6 字符用例即残 6）；64 字节 seed 的 103 字符编码（残 3）为合法输入
- 纯西里尔仿冒词（如 `xn--80ak6aa92e` = аррӏе）按方案口径不触发混排规则——「看起来像拉丁」检测需 confusables 表，超范围；G2 已锁定该边界为已知限制

F/G 组 24 用例（F1–F17 含 F9b / G1–G6），全量 84 → 108，四轮全绿 108/108 ×4。
