# WebStack Bridge (browser extension side)

English | [中文](README.zh.md)

An MV3 extension that borrows the **real browser session** to act as the rendering fallback for the `dsh-webstack-bridge` host: the host sends a `render-req` over a loopback WebSocket, the extension opens a background tab that loads the target page, injects an extraction script to take `document.title + outerHTML` (truncated to 2MB), and returns it as `render-res`. **Cookies / localStorage never leave the browser process** — the host only receives the extracted text.

Pure JS, zero build: this directory is not part of the pnpm workspace; install it directly as an "unpacked extension". The testable decision logic is concentrated in `logic.js` (pure functions), covered by `packages/bridge/tests/extension-logic.test.ts`.

## Install

1. Open `chrome://extensions` (any Chromium-based browser);
2. Enable "Developer mode" in the top-right corner;
3. Click "Load unpacked" and select this directory (`packages/bridge/extension/`);
4. Pin the toolbar icon; clicking it opens the pairing panel.

## Pairing steps

1. Start the host-side bridge service (the `dsh-webstack-bridge` assembly layer). It listens on a random port on **127.0.0.1** and prints a one-time ticket (valid for 60 seconds, consumable once) plus the port number in the log;
2. Copy the port from the log into the panel's "host port" field;
3. Copy the ticket from the log, paste it into the input box, and click "Pair";
4. On success the long-term key is delivered exactly once and saved in `chrome.storage.local`; from then on the extension reconnects automatically with the `auth(key)` handshake — no re-pairing needed.

Re-pairing = "Unpair" first, then repeat the flow above (the host rotates to a new key; the old key stops working immediately).

## Behavior notes

- **Heartbeat**: the host sends a protocol-level ping every 20s and Chrome answers pong automatically; the extension also understands the application-layer `{type:'ping'}` → `{type:'pong', id}` frames (protocol vocabulary mirror in `shared-protocol.js`).
- **Reconnection**: exponential backoff 1s / 2s / 4s / … capped at 60s; on 4001/4002/4003 (invalid ticket / protocol violation / key mismatch) or when not yet paired it does **not** reconnect — these are configuration or credential problems that require human intervention.
- **Render pipeline**: `chrome.tabs.create({active:false})` loads the page in the background → wait for `status==='complete'` (budget is `timeoutMs × 0.8`; on timeout the injection still runs — half a DOM beats none, and the host settles the total duration) → inject the extractor → close the tab → answer echoing the `render-req` id exactly.
- **Extraction injection** (W-A-18 countermeasure): the `func` of `chrome.scripting.executeScript` is serialized and rebuilt inside the page, so closures referencing module variables silently break. The extraction rules are therefore a serializable string `logic.js#EXTRACT_RULE_SOURCE`, passed in via `args` and executed in-page with `new Function`; its built-in truncation algorithm is isomorphic to `truncateContent`, locked by tests.

## Permissions (minimal necessary surface)

| Permission | Why it is needed |
| --- | --- |
| `tabs` | Create background tabs for rendering, listen to `onUpdated/onRemoved`, and `tabs.remove` when done |
| `scripting` | Inject the one-shot extraction function (title + outerHTML) into target pages |
| `storage` | Keep the host port and long-term key on this machine (`chrome.storage.local`, never uploaded or synced) |
| `host_permissions: <all_urls>` | Fallback render target URLs are decided by the host's search needs and cannot be enumerated as a whitelist; without it, injecting into any non-whitelisted site fails |

## Privacy statement

- Cookies, localStorage, and login state in the browser session **exist only in the browser process**; the extension never reads, forwards, or persists them to the host; the host only receives the extracted body text.
- Content transits in memory only: extraction results are sent as `render-res` to `ws://127.0.0.1:<port>` (local loopback only); the extension itself performs no persistence, telemetry, or third-party requests.
- The long-term key and port live in local `chrome.storage.local`; "Unpair" deletes the key.
