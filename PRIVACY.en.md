# QR2Link Privacy Policy

Last updated: 2026-11-05

[中文](PRIVACY.md) | English

QR2Link ("this extension") is built on one principle: **everything you scan is processed locally on your device**. This page describes what actually happens to your data.

## Data handling

### 1. Images and QR content: decoded locally, never uploaded

Images you provide via screenshot, upload, or paste — and the QR content decoded from them — are **decoded entirely inside your browser** (in the popup page or the extension's own hidden document). Nothing is uploaded to any third-party service. This extension runs no servers of its own and contains no analytics or tracking components.

### 2. The only network exception: right-click scanning of remote images

When you use the right-click "Scan QR code in image" action on a remote image, the browser makes **one request to that image's original address** to fetch its bytes (decoding still happens locally afterwards). Whether this succeeds depends on the image's cross-origin and access restrictions; cross-origin images usually fail. Every other entry point (screenshot / upload / paste) makes no network requests at all.

### 3. Scan history: local only, off by default, text only

- The history feature is **off by default**;
- Once enabled, a **text result** is saved to local `chrome.storage.local` (≤20 entries, **no images**) only when you explicitly click "Keep" on a result card;
- History entries may contain sensitive values such as login URLs, invite links, or authorization codes — mind what you keep;
- **Clearing your browser history does not clear this storage.** To delete entries, use the per-item "Delete" or the "Clear" button in the "Recent scans" area of the popup; uninstalling the extension also wipes it.

### 4. Clipboard: images only, read only on request, never written automatically

- The clipboard is read only when you click "Read image from clipboard" or press Ctrl+V inside the popup, and **only image types are accepted**; the data is released right after;
- Results are **never written to the clipboard automatically**; the only write happens when you click "Copy" on a result card.

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

## Contact

- Email: `VJoyqys@users.noreply.github.com` (a GitHub no-reply address, not a regular inbox)
- Preferred: GitHub Issues — https://github.com/vjoy233/qr2link/issues

## Changes

Material changes to this policy will be reflected on this page along with an updated date.
