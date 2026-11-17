# Live — Tauri v3 host

Runs the static edition (`../static`) as a Tauri 3.0.0-alpha.6 (Wry) app. The Worker, `src/app_live` and the
existing static hosting are unchanged; this directory is a second host.

- `npm run build` copies `../static` to `dist/`, adds the pinned consent broker (`runtime.js`), the host
  adapter (`host.js`) and the descriptor, and writes a per-page CSP derived from the descriptor. The two
  inline scripts and the inline style are allowed by hash; `'wasm-unsafe-eval'` is added because the bundle
  ships `live-v1/*.wasm`.
- The descriptor declares **no external operation**. The CSP is `connect-src 'self'`, so the room WebSocket
  and the XRPC calls (`joinRoom`, `sendCheer`) in `static/index.html` are refused; the page already falls
  back to local-only mode when they fail. Record changes and relay operations are a separate gate: declare
  them in `src/descriptor.mjs` with `consent: "each-operation"` before enabling them.
- `vendor/` is a pinned copy of the canonical `kotoba-client-runtime.js` and consent CSS
  (`kotoba-lang/kotoba` `lib/kotoba.wasmWebcomponent/src`, revision in `vendor/PINS.json`); the build fails
  if a digest drifts.
- `npm test` runs the node tests. `cd src-tauri && cargo check --locked` needs `npm run build` first.

Known defect, not caused by this host: `static/live-v1/kami_app_live_bg.wasm` fails to compile in Chromium
("opcode unreachable is not allowed in constant expressions"), with or without this wrapper, so the 3D scene
does not start there. It was not tested in a WKWebView.

Not done here: signed release, store publication, an installed-app run on a device, license resolution.
