# QR2Link Privacy Policy

Last updated: 2026-11-14

[中文](PRIVACY.md) | English

QR2Link ("this extension") is built on one principle: **everything you scan is processed locally on your device**. This page describes what actually happens to your data.

## Data handling

### 1. Images and QR content: decoded locally, never uploaded

Images you provide via screenshot, upload, or paste — and the QR content decoded from them — are **decoded entirely inside your browser** (in the popup page or the extension's own hidden document). Nothing is uploaded to any third-party service. This extension runs no servers of its own and contains no analytics or tracking components. The decode engines (including the WebAssembly build of zxing) are all bundled with the extension and executed locally; no code is downloaded from anywhere at runtime.

### 2. Camera scanning: frames processed in memory only, never on disk

The camera scan page obtains the video stream via the browser's `getUserMedia` (**runtime permission**: prompted by the browser on first use, revocable from the address-bar permission icon; the manifest permission list is unchanged). Video frames are drawn to an in-memory canvas and decoded in place — **no screenshots, no recording, no disk writes**, and no network requests. The camera stops immediately when the scan page is closed or moved to the background. The scan page's "open / auto-open after scanning" is not safety-pre-checked (risk ratings apply only to popup result cards) — "auto-open" is an explicit opt-in switch, off by default and session-only.

### 3. QR generation: fully local

All generation computation (encoding, styling, logo compositing) happens locally in the popup page; the downloaded PNG is triggered via a data-URI through the browser's own download, and "Copy image" writes to the clipboard only when you click it. Generation makes no network requests and the generated content is never uploaded.

### 4. The only network exception: right-click scanning of remote images

When you use the right-click "Scan QR code in image" action on a remote image, the browser makes **one request to that image's original address** to fetch its bytes (decoding still happens locally afterwards). Whether this succeeds depends on the image's cross-origin and access restrictions; cross-origin images usually fail. Every other entry point (screenshot / upload / paste) makes no network requests at all.

### 5. Scan history: local only, off by default, text only

- The history feature is **off by default**;
- Once enabled, a **text result** is saved to local `chrome.storage.local` (≤20 entries, **no images**) only when you explicitly click "Keep" on a result card;
- History entries may contain sensitive values such as login URLs, invite links, or authorization codes — mind what you keep;
- One-time-password contents (otpauth://) include the service secret key: once kept, the secret is **stored verbatim in local history**, while the UI only masks it at the display layer (click "Show" to reveal; copying uses the original). Live codes are computed locally by the browser's built-in WebCrypto and never uploaded;
- **Clearing your browser history does not clear this storage.** To delete entries, use the per-item "Delete" or the "Clear" button in the "Recent scans" area of the popup; uninstalling the extension also wipes it.

### 6. Clipboard: images only, read only on request, never written automatically

- The clipboard is read only when you click "Read image from clipboard" or press Ctrl+V inside the popup, and **only image types are accepted**; the data is released right after;
- Results are **never written to the clipboard automatically**; writes happen only when you click "Copy" (scanned text, camera results, or generated QR images).

## Permissions and purposes

| Permission | Purpose |
|------------|---------|
| `activeTab` | Captures the current tab only when you explicitly use the extension |
| `clipboardRead` | Reads clipboard images only, for local QR decoding; never reads/uploads text or other data |
| `clipboardWrite` | Writes a result only when you click the Copy button |
| `contextMenus` | Provides the right-click "scan image" entry |
| `offscreen` | Decodes images locally in a hidden document |
| `storage` | Stores kept scan records locally, only after you enable history |

This extension does not request `<all_urls>`, `host_permissions`, `tabs`, or any other broad permissions.

Two additional notes:

- **Camera**: the scan page uses the browser's `getUserMedia` **runtime permission** (not a manifest permission; prompted on first use, revocable at any time);
- **CSP `wasm-unsafe-eval`**: this entry in the manifest's content security policy exists solely to let the WebAssembly decode engine (zxing) bundled with the extension execute locally (Chrome Web Store policy explicitly allows bundled wasm); it grants no data access.

## Contact

- Email: `VJoyqys@users.noreply.github.com` (a GitHub no-reply address, not a regular inbox)
- Preferred: GitHub Issues — https://github.com/vjoy233/qr2link/issues

## Changes

Material changes to this policy will be reflected on this page along with an updated date.
