# QR2Link

[中文](README.md) | English

A Chrome / Edge extension (Manifest V3, no build step, zero third-party uploads) that decodes QR / barcodes from images **entirely on your device** into text or web links — and generates styled QR codes from your text and links. A two-way QR toolbox.

The UI follows your browser language automatically: 简体中文 (zh-CN) and English are bundled; all other locales fall back to English.

Login codes, payment codes, sharing codes on a web page — no need to grab your phone. Let the browser read the QR code itself.

## Features

### Four core entry points

| Entry | Description |
|-------|-------------|
| 📷 **Capture current page** | Screenshot the visible area of the active tab; optionally **drag a selection** around the QR code before scanning |
| 📁 **Upload image** | Pick a local image file, or simply **drag & drop** it onto the popup |
| 🎥 **Camera scan** | Live scanning in a dedicated tab — stops on a hit, with open / copy / keep-scanning actions (camera use requires the browser's runtime permission; frames are processed in local memory only) |
| ⚡ **Generate QR code** | Text / link → styled QR code: dot × corner styles, foreground / background colors, center logo, PNG download / copy |

Plus the 📋 **clipboard channel**: click "Read image from clipboard" or just press **Ctrl+V** (e.g. after a Win+Shift+S system screenshot).

### Recognition

- **Mainstream QR and barcode formats**: QR, DataMatrix, Aztec, PDF417, and common 1D barcodes (EAN-13/UPC-A, Code128, Code39, Code93, ITF, Codabar) — exhaustive format coverage is not promised
- **Decode engines**: zxing-wasm (WebAssembly bundled with the extension, **executed locally, zero network**) merged with the native BarcodeDetector where available, with jsQR as the emergency fallback; a three-stage strategy (downscaled fast scan → full-resolution retry → quadrant tiling rescan when nothing is found) covers small codes in large images and multi-code images
- **Structured parsing**: WIFI: (copyable password), otpauth:// (TOTP codes computed locally by the browser's WebCrypto per RFC 6238, secret masked by default), vCard (downloadable .vcf), tel: / sms: / mailto: / geo: (semantic cards, copy only)

### Extras

- **Safety pre-check**: http/https results in the popup get a purely local heuristic rating (homograph domains / embedded credentials / plain HTTP / IP hosts / short links); high-risk links require a two-step confirm to open
- **Keyboard shortcut** (default `Alt+Shift+S`): captures the current page and scans it; if an http/https link is found, the first one opens automatically (note: this path is **not** safety-pre-checked — see Usage tips)
- **Context menu**: right-click any image → "Scan QR code in image" (remote cross-origin images are experimental, see below)
- **Scan history**: off by default; once enabled it stores only text results you explicitly "Keep" (≤20 entries, no images)
- **Bilingual UI** (incl. context menu, shortcut description, store listing) — see [I18N-PLAN.md](I18N-PLAN.md)

## Known limitations

- zh-TW / zh-HK browsers: no Traditional Chinese pack is bundled yet — the UI falls back to English (Simplified Chinese users are unaffected)
- All-format recognition is best-effort: heavily damaged, densely packed or exotic codes may be missed — draw a selection around the code and retry
- Camera scan depends on the browser's `getUserMedia` runtime permission; denied permission or missing devices show an in-page guide

## Install (developer mode)

**Option 1: download a Release package (recommended for most users)** — grab `qr2link-v*.zip` from [Releases](https://github.com/vjoy233/qr2link/releases), unzip it, then follow steps 2–5 below selecting the unzipped folder.

**Option 2: clone the repo (developers)** — download / clone this repository and load the repo root the same way.

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked" and select the folder containing `manifest.json`
4. The QR2Link icon appears in the toolbar — you're done

After changing code, click "Reload" on the extensions page.

> Requires Chrome / Edge 116+ (depends on `chrome.runtime.getContexts`). Firefox is not supported.

## Changing the shortcut

`chrome://extensions/shortcuts` (Edge: `edge://extensions/shortcuts`) → find QR2Link → edit "Capture the current page and scan it for QR codes".

## Permissions & why

This extension follows least-privilege and **deliberately does not request** `<all_urls>`, `host_permissions`, or `tabs`.

| Permission | Purpose |
|------------|---------|
| `activeTab` | Captures the current tab only when you explicitly use the extension |
| `clipboardRead` | Reads clipboard images only, for local QR decoding; never reads/uploads text or other data |
| `clipboardWrite` | Writes a result only when you click the Copy button (text or generated QR image) |
| `contextMenus` | Provides the right-click "scan image" entry |
| `offscreen` | Decodes images locally in a hidden document |
| `storage` | Stores kept scan records locally, only after you enable history |

Two notes:

- **The camera is not a manifest permission**: camera scanning goes through the browser's `getUserMedia` **runtime permission** (prompted on first use, revocable from the address-bar permission icon) — the manifest permission list is unchanged.
- **CSP `wasm-unsafe-eval`**: the manifest's `content_security_policy` includes this so the bundled WebAssembly decode engine (zxing-cpp, executed locally, zero network) can run; Chrome Web Store policy explicitly allows bundled wasm. It is not a permission and grants no data access.

## Privacy (summary)

- Images, camera frames and QR content are **decoded entirely on your device and never uploaded**; neither recognition nor generation makes network requests
- The only network exception: right-click scanning of a **remote image** sends one request to that image's original address to fetch its bytes; cross-origin images usually fail (a deliberate trade-off — no wider permissions are requested)
- Camera frames are decoded in memory frame by frame (no screenshots, no recording, no disk writes); the camera stops when the scan page is closed
- Results are **never written to the clipboard automatically**; writing happens only when you click "Copy"
- History lives only in local `chrome.storage.local`, is off by default, and stores only text you explicitly kept; clearing browser history does **not** clear it — use the "Clear" button in the popup

Full policy: [PRIVACY.en.md](PRIVACY.en.md).

## Usage tips

- Special pages (`chrome://` settings, the built-in PDF viewer, …) may refuse capture → take a system screenshot, then paste / upload
- Non-URL content (Wi-Fi passwords, contact cards, …) is only displayed verbatim with a copy button — never rewritten or searched; tel: / sms: / mailto: / geo: cards likewise offer copy only, never auto-open
- `javascript:` / `data:` and other non-http(s) payloads are never opened
- **The shortcut auto-open and the camera page's "open / auto-open" are not safety-pre-checked** (the pre-check only applies to popup result cards) — this is a deliberate layering: scan-to-open paths stay zero-friction (the camera "auto-open" is an explicit opt-in, off by default); rely on the popup path when you want risk ratings
- Small codes inside large images trigger an automatic full-resolution retry; if that fails, draw a selection around the code and retry
- **Multiple codes per image**: zxing decodes multiple codes in a single pass; the jsQR emergency path runs an automatic **quadrant tiling rescan** on multi-code images it misses as a whole (side-by-side / stacked pairs, four-corner layouts and other common cases are all recovered). For dense layouts or when only one code is found, **draw a selection** around the target code
- The camera page's "auto-open after scanning" switch is off by default and session-only (not persisted); switching the tab to the background or closing the page stops the camera

## Development

```
qr2link/
├── manifest.json       # MV3 manifest (no build; repo root IS the extension root; CSP allows wasm)
├── _locales/           # chrome.i18n message catalogs (en + zh_CN, default_locale=en)
├── background.js       # Service Worker: shortcut scan, context menu, offscreen lifecycle
├── offscreen.html/.js  # hidden decode document (shortcut / context-menu flows only)
├── qr.js               # shared decode module (native→zxing→jsQR chain + 3-stage strategy + decodeFrame)
├── parsers.js          # structured parsing (WIFI/otpauth/vCard/tel/sms/mailto/geo, purely local)
├── safety.js           # link safety pre-check (local heuristics: homograph/userinfo/HTTP/IP/short links)
├── i18n.js             # loads chrome.i18n messages into self.I18N (callers unchanged)
├── popup/              # popup: four entries, crop component, result cards (parsing + pre-check), history, generator
├── camera/             # camera scan tab (getUserMedia runtime permission, no new manifest permissions)
├── lib/                # vendored: jsQR / zxing-reader+wasm / qr-code-styling (SHA256-pinned)
├── THIRD_PARTY_LICENSES/  # full texts of all third-party licenses
├── icons/              # icons (icon.svg is the source; scripts/gen-icons.mjs renders PNGs)
└── test/               # test page + sample codes + e2e (generated locally, no network)
```

```bash
npm install                   # dev/test dependencies only (qrcode, sharp, …)
node test/gen-qr.mjs          # regenerate sample QR images
node scripts/gen-icons.mjs    # regenerate icon PNGs
node scripts/vendor-sync.mjs  # vendor sync + SHA256 verification (release gate)
npm run check:locales         # _locales integrity check (key parity, closure, manifest tokens)
```

Open `test/index.html` in a browser for manual verification (screenshot / upload / paste / camera / shortcut / context menu).

Debug entry points: right-click inside the popup → Inspect; "service worker" on the extensions page; `chrome://extensions` → inspect views → offscreen.html.

### Automated acceptance (test/e2e)

Playwright drives a real browser with the unpacked extension loaded — 149 acceptance cases (the automatable subset of DESIGN §8):

```bash
cd test/e2e
NODE_PATH="$(npm root -g)" node run-all.cjs msedge                          # primary: Edge, Chinese UI
NODE_PATH="$(npm root -g)" node run-all.cjs chromium                        # cross-check, Chinese UI
QR2LINK_E2E_LANG=en-US NODE_PATH="$(npm root -g)" node run-all.cjs chromium # English UI regression
```

- Branded Chrome 137+ dropped `--load-extension`; run automation on Edge / Playwright Chromium. Manual Chrome items: `TEST-RESULTS.md` §6
- The suite injects real OS key events (Alt+Shift+S) and reads/writes the system clipboard — it briefly takes over the foreground window; camera cases use Chromium's fake media device (no physical camera needed), including a "real-device equivalent" pair that feeds a real QR image through the full production pipeline via an MJPEG file capture device
- Reports land in `test/e2e/report/`; run-all step-0 gates are `check-locales` + `vendor-sync`; measured results: [TEST-RESULTS.md](TEST-RESULTS.md)

## Design docs

Architecture and the full decision log: [DESIGN.md](DESIGN.md) (Chinese). The v1.2 "two-way toolbox" plan: [V1.2-PLAN.md](V1.2-PLAN.md) (Chinese).

## License

This project's code is under the [MIT License](LICENSE). Third-party components bundled with the extension (full texts in [THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/)):

| Component | Purpose | License |
|-----------|---------|---------|
| [jsQR](https://github.com/cozmo/jsQR) | emergency QR decode engine | Apache-2.0 |
| [zxing-wasm](https://github.com/soxley/zxing-wasm) (wrapper) / [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (engine) | all-format WebAssembly decode engine, executed locally | MIT / Apache-2.0 |
| [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) (embeds [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)) | QR generation & styling | MIT / MIT |
