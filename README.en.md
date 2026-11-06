# QR2Link

[中文](README.md) | English

A Chrome / Edge extension (Manifest V3, no build step, zero third-party uploads) that decodes QR codes from images **entirely on your device** into text or web links you can open with one click.

Login codes, payment codes, sharing codes on a web page — no need to grab your phone. Let the browser read the QR code itself.

> The UI follows your browser language automatically: 简体中文 (zh-CN) and English are bundled; all other locales fall back to English. (zh-TW/HK users: see Known limitations below.)

## Features

### Three core entry points

| Entry | Description |
|-------|-------------|
| 📷 **Capture current page** | Screenshot the visible area of the active tab; optionally **drag a selection** around the QR code before scanning |
| 📁 **Upload image** | Pick a local image file, or simply **drag & drop** it onto the popup |
| 📋 **Clipboard paste** | Click "Read image from clipboard" or just press **Ctrl+V** (e.g. after a Win+Shift+S system screenshot) |

### Extras

- **Keyboard shortcut** (default `Alt+Shift+S`): captures the current page and scans it; if an http/https link is found, the first one opens automatically
- **Context menu**: right-click any image → "Scan QR code in image" (remote cross-origin images are experimental, see below)
- **Scan history**: off by default; once enabled it stores only text results you explicitly "Keep" (≤20 entries, no images)
- **Dual decode engines**: native BarcodeDetector (supports multiple codes per image where available) + jsQR fallback (handles inverted codes); a three-stage strategy (downscaled fast scan → full-resolution retry → quadrant tiling rescan when nothing is found) covers small codes in large images and multi-code images

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
| `clipboardWrite` | Writes a result only when you click the Copy button |
| `contextMenus` | Provides the right-click "scan image" entry |
| `offscreen` | Decodes images locally in a hidden document |
| `storage` | Stores kept scan records locally, only after you enable history |

## Privacy (summary)

- Images and QR content are **decoded entirely on your device and never uploaded** to any third party
- The only network exception: right-click scanning of a **remote image** sends one request to that image's original address to fetch its bytes; cross-origin images usually fail (a deliberate trade-off — no wider permissions are requested)
- Results are **never written to the clipboard automatically**; writing happens only when you click "Copy"
- History lives only in local `chrome.storage.local`, is off by default, and stores only text you explicitly kept; clearing browser history does **not** clear it — use the "Clear" button in the popup

Full policy: [PRIVACY.en.md](PRIVACY.en.md).

## Usage tips

- Special pages (`chrome://` settings, the built-in PDF viewer, …) may refuse capture → take a system screenshot, then paste / upload
- Non-URL content (Wi-Fi passwords, contact cards, …) is only displayed verbatim with a copy button — never rewritten or searched
- `javascript:` / `data:` and other non-http(s) payloads are never opened
- Small codes inside large images trigger an automatic full-resolution retry; if that fails, draw a selection around the code and retry
- **Multiple codes per image**: where native BarcodeDetector is available (some mobile platforms) all results show at once; on Windows desktop (jsQR), images that fail as a whole get an automatic **quadrant tiling rescan** (side-by-side / stacked pairs, four-corner layouts and other common cases are all recovered). For dense layouts or when only one code is found, **draw a selection** around the target code

## Known limitations

- zh-TW / zh-HK browsers: no Traditional Chinese pack is bundled yet — the UI falls back to English (Simplified Chinese users are unaffected). Tracking issue: TBD

## Development

```
qr2link/
├── manifest.json       # MV3 manifest (no build; repo root IS the extension root)
├── _locales/           # chrome.i18n message catalogs (en + zh_CN, default_locale=en)
├── background.js       # Service Worker: shortcut scan, context menu, offscreen lifecycle
├── offscreen.html/.js  # hidden decode document (shortcut / context-menu flows only)
├── qr.js               # shared decode module (dual engines + 3 stages, popup/offscreen)
├── i18n.js             # loads chrome.i18n messages into self.I18N (callers unchanged)
├── popup/              # popup: three entries, crop component, result cards, history
├── lib/jsQR.js         # jsQR 1.4.0 official dist (vendored, pinned)
├── icons/              # icons (icon.svg is the source; scripts/gen-icons.mjs renders PNGs)
└── test/               # test page + sample QR codes (generated locally, no network)
```

```bash
npm install                 # dev/test dependencies only (qrcode, sharp, …)
node test/gen-qr.mjs        # regenerate sample QR images
node scripts/gen-icons.mjs  # regenerate icon PNGs
npm run check:locales       # _locales integrity check (key parity, closure, manifest tokens)
```

Open `test/index.html` in a browser for manual verification (screenshot / upload / paste / shortcut / context menu).

Debug entry points: right-click inside the popup → Inspect; "service worker" on the extensions page; `chrome://extensions` → inspect views → offscreen.html.

### Automated acceptance (test/e2e)

Playwright drives a real browser with the unpacked extension loaded — 69 acceptance cases (the automatable subset of DESIGN §8):

```bash
cd test/e2e
NODE_PATH="$(npm root -g)" node run-all.cjs msedge                          # primary: Edge, Chinese UI
NODE_PATH="$(npm root -g)" node run-all.cjs chromium                        # cross-check, Chinese UI
QR2LINK_E2E_LANG=en-US NODE_PATH="$(npm root -g)" node run-all.cjs chromium # English UI regression
```

- Branded Chrome 137+ dropped `--load-extension`; run automation on Edge / Playwright Chromium. Manual Chrome items: `TEST-RESULTS.md` §6
- The suite injects real OS key events (Alt+Shift+S) and reads/writes the system clipboard — it briefly takes over the foreground window
- Reports land in `test/e2e/report/`; the run-all step 0 gate is `npm run check:locales`

## Design docs

Architecture and the full decision log: [DESIGN.md](DESIGN.md) (Chinese). The bilingual adaptation plan: [I18N-PLAN.md](I18N-PLAN.md).

## License

This project's code is under the [MIT License](LICENSE). `lib/jsQR.js` is an official build of [cozmo/jsQR](https://github.com/cozmo/jsQR) (Apache-2.0); the full text is at [THIRD_PARTY_LICENSES/jsQR-Apache-2.0.txt](THIRD_PARTY_LICENSES/jsQR-Apache-2.0.txt).
