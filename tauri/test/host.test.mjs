import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  clientRuntimeConnectSrc, clientRuntimeProblems, createClientConsentHost,
  createClientOperationBroker, verifyClientArtifact,
} from "../vendor/kotoba-client-runtime.js";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const hex = /^[0-9a-f]{64}$/;
const hashB64 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const build = (env = {}) => execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")],
  { env: { ...process.env, ...env }, stdio: "pipe" });
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-fixture-"));
  return { src: path.join(dir, "in"), out: path.join(dir, "out") };
};

test("the descriptor is restricted-wasm-v1 with memory state and no operations", () => {
  assert.equal(descriptor.profile, "restricted-wasm-v1");
  assert.deepEqual(descriptor["local-state"], { adapter: "memory", schema: "live.session.v1", version: 1 });
  assert.deepEqual(descriptor.operations, []);
  assert.deepEqual(requestedCapabilities(descriptor), []);
  assert.deepEqual(
    clientRuntimeProblems(descriptor, requestedCapabilities(descriptor), ["https://tauri.localhost"]), []);
  assert.equal(clientRuntimeConnectSrc(descriptor, [], [], ["https://tauri.localhost"]), "connect-src 'none'");
});

test("the build pins the vendor runtime and writes a verified host plus a guest artifact", () => {
  build();
  const pins = JSON.parse(readFileSync(path.join(here, "vendor/PINS.json"), "utf8"));
  assert.equal(pins.revision, "a1b90e38c9e5334facfa993062e237299c70de10");
  assert.equal(pins.files["kotoba-client-runtime.js"],
    "d6f67c058c5c40fc56fe500648dc79704a2eee02d4af75fc17898aad1f560a75");
  const css = createHash("sha256").update(readFileSync(path.join(here, "vendor/kotoba-client-consent.css"))).digest("hex");
  assert.equal(pins.files["kotoba-client-consent.css"], css);
  assert.equal(css.length, 64);
  for (const [name, digest] of Object.entries(pins.files)) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(here, "dist/vendor", name))).digest("hex"),
      digest, `dist/vendor/${name} equals the pin`);
  }
  const release = JSON.parse(readFileSync(path.join(here, "dist/release.json"), "utf8"));
  assert.equal(release.profile, "restricted-wasm-v1");
  assert.ok(hex.test(release.guest.sha256), "guest digest is pinned");
  assert.equal(release.guest.revision,
    execFileSync("git", ["-C", path.join(here, ".."), "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  // The wasm travels inside the guest; no separate fetchable artifact ships.
  assert.ok(!("live-v1/kami_app_live_bg.wasm" in release.files), "the wasm is inlined, not shipped");
  for (const [, digest] of Object.entries(release.files)) assert.ok(hex.test(digest));
});

test("the host page carries the exact derived CSP and no inline code", () => {
  build();
  const index = readFileSync(path.join(here, "dist/index.html"), "utf8");
  const conf = JSON.parse(readFileSync(path.join(here, "src-tauri/tauri.conf.json"), "utf8"));
  const csp = index.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.equal(conf.app.security.csp, csp);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /'wasm-unsafe-eval'/, "inlined wasm instantiates from bytes");
  for (const tag of index.matchAll(/<script\b[^>]*>/gi)) assert.ok(/src=/.test(tag[0]), `no inline script in the host: ${tag[0]}`);
  assert.ok(!/<style[\s>]/i.test(index), "no inline style in the host");
});

test("the guest verifies against its pin and a one-byte change is refused", async () => {
  build();
  const { default: host } = await import(pathToFileURL(path.join(here, "dist/host-data.js")).href);
  assert.deepEqual(host.descriptor, descriptor);
  const release = JSON.parse(readFileSync(path.join(here, "dist/release.json"), "utf8"));
  assert.deepEqual(host.artifact, release.guest);
  const artifact = await verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact);
  assert.equal(artifact.verified, true);
  await assert.rejects(
    verifyClientArtifact(new TextEncoder().encode(host.guest.slice(0, -1) + "x"), host.artifact),
    /digest mismatch/);
});

test("the guest inlines the wasm and reaches no service origin", async () => {
  build();
  const { default: host } = await import(pathToFileURL(path.join(here, "dist/host-data.js")).href);
  const scripts = [...host.guest.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "the guest holds exactly one inline script");
  const [, script] = scripts[0];
  assert.ok(!/new WebSocket|WebSocket\(/.test(script), "the guest opens no WebSocket");
  assert.ok(!/live\.etzhayyim\.com|l1ve9pq4\.etzhayyim\.com|mcp\.etzhayyim\.com/.test(script),
    "the guest reaches no live service origin");
  assert.ok(!/createClientOperationBroker|<script src|<link/.test(script), "no broker or external resource in the guest");
  const wasm = readFileSync(path.join(here, "../static/live-v1/kami_app_live_bg.wasm")).toString("base64");
  assert.ok(script.includes(`var WASM_B64="${wasm.slice(0, 64)}`), "the wasm bytes are inlined");
  assert.ok(/__wbg_init\(\{ module_or_path: bytes\(\) \}\)/.test(script), "the wasm instantiates from bytes");
  const styles = [...host.guest.matchAll(/<style>([\s\S]*?)<\/style>/gi)];
  assert.equal(styles.length, 1, "the guest holds exactly one inline style");
  const index = readFileSync(path.join(here, "dist/index.html"), "utf8");
  const csp = index.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes(hashB64(script)), "page CSP admits the guest script by hash");
  assert.ok(csp.includes(hashB64(styles[0][1])), "page CSP admits the guest style by hash");
});

test("the broker refuses every call for an operation-free app before any dialog", async () => {
  const makeEl = () => ({
    children: [],
    setAttribute() {},
    addEventListener() {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
  });
  globalThis.document = { body: makeEl(), createElement: makeEl };
  const consentHost = createClientConsentHost({ locale: "ja" });
  const broker = createClientOperationBroker({ runtime: descriptor, consentHost });
  assert.deepEqual(broker.operations, []);
  await assert.rejects(
    broker.invoke({ capability: "net", service: "x", operation: "y" }, {}),
    /not eligible/);
});

test("the build fails closed on a CSP drift without WRITE_CSP=1", () => {
  build();
  const confPath = path.join(here, "src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const saved = conf.app.security.csp;
  conf.app.security.csp = "default-src 'none'";
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  try {
    assert.throws(() => build(), /csp differs/);
  } finally {
    conf.app.security.csp = saved;
    writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  }
  const f = fixture();
  assert.throws(() => build({ STATIC_SRC: path.join(f.src, "nope"), TAURI_DIST: f.out }), /missing/);
});
