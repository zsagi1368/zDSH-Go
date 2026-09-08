# dsh-webstack-bridge

WebStack Bridge (网栈·桥) — browser-bridge satellite package (**host side**) for
the [dsh-webstack](../webstack) plugin family.

An MV3 browser extension borrows its real browser session to act as a rendering
fallback (tier T3): when a page needs JS-rendered content the host forwards a
`render-req` over a loopback WebSocket, the extension renders it in a real tab
and returns extracted text. **Cookies never leave the browser** — the host
process only ever receives already-extracted content text.

## Why `ws` is this package's single runtime dependency

Node (>=22) ships a WebSocket **client** in the standard library but no
WebSocket **server**. The bridge host must accept connections from the
extension, so a server implementation is unavoidable; `ws` is the de-facto pure
JS choice with zero native bindings (the monorepo forbids native modules). That
makes it the one and only runtime dependency of this satellite — everything else
(`@deepseek-ai/cordis`, `dsh-webstack`) is an optional peer provided by the host.

## Pairing flow (W-B-58)

```
host log            extension popup              storage
─────────           ───────────────              ───────
issueTicket()
  │ logger.info ──► user pastes ticket
  ▲                 {type:'pair',id,ticket} ──►
  │                 ◄── {type:'paired',id,key}
  │                        long-term key ──────► chrome.storage (extension side)
  └─ only sha256(key) retained on the host
```

1. On startup the plugin logs a one-time ticket: valid for **60 seconds**, single
   use. If it expires, reload the plugin / restart the host for a fresh line.
2. The extension connects to `ws://127.0.0.1:<port>` and sends
   `{type:'pair', id, ticket}`. The server replies `{type:'paired', id, key}`.
   The plaintext key is delivered **exactly once**; the host keeps only
   `sha256(key)` (tickets are likewise stored hashed).
3. Afterwards the extension authenticates on every reconnect with
   `{type:'auth', id, key}` → `{type:'auth-ok', id}`. The long-term key lives in
   extension storage only.
4. Re-pairing rotates the key hash: the previous key stops working immediately.

### Close codes (no auto-reconnect hint)

| code | meaning | action |
|------|---------|--------|
| 4001 | pair rejected (missing/expired/replayed ticket) | fetch a fresh ticket |
| 4002 | protocol violation (bad JSON, missing ack id, unknown frame) | fix client |
| 4003 | auth failed (key mismatch or nothing paired yet) | re-pair |

All three are configuration/credential problems — clients must surface them to
the user instead of retrying in a loop.

### Origin gate

The upgrade handshake accepts only `chrome-extension://*` origins **or a missing
Origin header**: MV3 service workers may legitimately omit it, while malicious
web pages are always forced by browsers to send their own origin and fall into
the rejection branch. `Sec-Fetch-*` headers are not required. The actual access
control is the pairing protocol above, not the header check.

## Heartbeat

Server pings every 20s and terminates a connection that has sent no pong for
60s (enforcement granularity lags at most one ping interval). Half-open sockets
therefore never hang in-flight render requests — their pending renders settle
to `undefined` and `onDisconnect` fires so the kernel can degrade to `site:`
searches.

## Render contract (`SeamBridgeRuntime` shape)

```ts
render(url: string, timeoutMs: number): Promise<{ content: string; statusCode: number } | undefined>
```

- `undefined` = bridge unavailable this time: no paired connection, timeout,
  peer answered `ok:false`, disconnect mid-flight, or **SSRF gate rejected the
  target**. Callers degrade; nothing throws.
- Requests are queued **serially** (a browser tab is a scarce resource).
- Strict ACK discipline: every request carries a monotonic integer `id` and its
  response echoes it; late/mismatched render responses are ignored.
- SSRF: every URL must pass dsh-webstack's `checkTarget` (gates G1+G2). To avoid
  deep-path imports the checker is injected at assembly time
  (`deps.checkTarget` / `setTargetChecker`); until injected the renderer is
  fail-closed and never dispatches a request.

## Cordis assembly

```ts
import * as bridge from 'dsh-webstack-bridge';
ctx.plugin(bridge, { enabled: true });
// ctx.bridge.render(url, timeoutMs) — named service `bridge`
```

`apply()` starts the loopback server (random port via `getPort()`), provides the
named service, logs the first pairing ticket, and registers disposal so the port
and all sockets are released with the fiber.
