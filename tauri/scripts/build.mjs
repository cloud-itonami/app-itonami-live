// Package the live show as a restricted-wasm-v1 Tauri frontend (KOTOBA-159).
// The network edition opened a WebSocket to the room DO and bootstrapped
// room state over XRPC; the restricted guest has connect-src 'none', so the
// show runs offline: the live-v1 wasm is inlined (base64) and instantiated
// from bytes ('wasm-unsafe-eval' is allowed, fetch is not), cheers fire
// locally, presence stays at 1. No parent DOM, no persistence. The host page
// verifies the guest against the digest pinned here and mounts it in a
// sandboxed iframe.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";

const here = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(here, "..");
const source = path.resolve(process.env.STATIC_SRC ?? path.join(here, "../static"));
const out = path.resolve(process.env.TAURI_DIST ?? path.join(here, "dist"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaB64 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const fail = (message) => { console.error(`tauri build: ${message}`); process.exit(1); };

const pins = JSON.parse(await readFile(path.join(here, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(path.join(here, "vendor", name))) !== digest) fail(`canonical runtime pin drift: ${name}`);
}

const capabilities = requestedCapabilities(descriptor);
const origins = ["https://tauri.localhost"];
const problems = clientRuntimeProblems(descriptor, capabilities, origins);
if (problems.length) fail(`descriptor is invalid: ${JSON.stringify(problems)}`);
if (descriptor.profile !== "restricted-wasm-v1") fail(`profile is ${descriptor.profile}; this build only ships restricted-wasm-v1`);
const connect = clientRuntimeConnectSrc(descriptor, capabilities, [], origins);
if (connect !== "connect-src 'none'") fail(`connect-src must be 'none' for an operation-free app: ${connect}`);

const index = await readFile(path.join(source, "index.html"), "utf8").catch(() => null);
if (index === null) fail(`${path.join(source, "index.html")} is missing`);
const title = (() => {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(index);
  if (!m) fail("static/index.html has no <title>");
  return m[1];
})();
const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/gi)];
if (styles.length !== 1) fail(`static/index.html must hold exactly one <style>: found ${styles.length}`);
const style = styles[0][1];
if (/<\/style/i.test(style)) fail("guest style contains </style");
const blocks = [...index.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if (blocks.length !== 1) fail(`static/index.html must hold exactly one classic <script> (the audio synth): found ${blocks.length}`);
const audio = blocks[0][1];
if (/\bfetch\(|WebSocket|XMLHttpRequest|EventSource|https?:\/\//.test(audio)) {
  fail("the audio synth must stay offline");
}
const body = ((m) => {
  if (!m) fail("static/index.html has no <body>");
  const stripped = m[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  if (/<script[\s>]/i.test(stripped)) fail("guest body carries a script after stripping");
  if (/<iframe[\s>]/i.test(stripped)) fail("guest body must not carry an iframe (frame-src 'none')");
  if (/<form[\s>]/i.test(stripped)) fail("guest body must not carry a form (form-action 'none')");
  for (const id of ["gc", "hud", "cheers", "start", "enter"]) {
    if (!new RegExp(`id="${id}"`).test(stripped)) fail(`guest body lost #${id}`);
  }
  return stripped;
})(/<body[^>]*>([\s\S]*?)<\/body>/i.exec(index));

let glue = await readFile(path.join(source, "live-v1/kami_app_live.js"), "utf8").catch(() => null);
if (glue === null) fail(`${path.join(source, "live-v1/kami_app_live.js")} is missing`);
// Inline the wasm-bindgen glue as classic script: drop the module exports,
// and the fetch-by-path branch (the wasm comes from the inlined bytes;
// import.meta is a syntax error in a classic script).
glue = glue
  .replace(/^export (?=function)/gm, "")
  .replace(/^export \{[^}]*\};?\s*$/gm, "")
  .replace(/module_or_path = new URL\('kami_app_live_bg\.wasm', import\.meta\.url\);/,
    `throw new Error('live wasm must be inlined; see tauri/scripts/build.mjs');`);
if (/^\s*export\b/m.test(glue)) fail("the glue still exports after stripping");
if (/import\.meta/.test(glue)) fail("the glue still uses import.meta (classic-script syntax error)");
const wasmBytes = await readFile(path.join(source, "live-v1/kami_app_live_bg.wasm")).catch(() =>
  fail(`${path.join(source, "live-v1/kami_app_live_bg.wasm")} is missing`));
const wasmConst = `var WASM_B64="${wasmBytes.toString("base64")}";`;
const main = await readFile(path.join(here, "src/guest-main.js"), "utf8");
const guestScript = `${audio}\n${glue}\n${wasmConst}\n${main}`;
if (/<\/script/i.test(guestScript)) fail("guest script contains </script");
if (/^\s*(import|export)\b/m.test(guestScript)) fail("the restricted guest script must not import or export");
if (/\bWebSocket\(|new WebSocket/.test(guestScript)) fail("the guest must not open a WebSocket");
if (/https?:\/\/(live\.etzhayyim\.com|l1ve9pq4\.etzhayyim\.com|mcp\.etzhayyim\.com)/.test(guestScript)) {
  fail("the guest still reaches a live service origin");
}
if (/\bfetch\(/.test(glue)) {
  // The only fetch left may be the dead string/Request branch of __wbg_init;
  // bytes never take it. Anything else stops the build.
  const uses = glue.split("\n").filter((line) => /\bfetch\(/.test(line) && !/module_or_path = fetch\(module_or_path\)/.test(line));
  if (uses.length) fail(`the glue fetches outside the dead path branch: ${uses[0].trim().slice(0, 120)}`);
}

const fill = (template, what, values) => template.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => {
  if (!Object.hasOwn(values, key)) fail(`${what} has an unfilled placeholder {{${key}}}`);
  return values[key];
});
const vendorText = await readFile(path.join(here, "vendor/kotoba-client-runtime.js"), "utf8");
const preambleText = (() => {
  const m = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(vendorText);
  if (!m) fail("vendor/kotoba-client-runtime.js has no GUEST_PREAMBLE this build can hash");
  return m[1];
})();

const commit = (() => {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    fail("restricted-wasm-v1 pins the guest to its source commit: build from a git checkout");
  }
})();
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`git rev-parse HEAD gave ${JSON.stringify(commit)}`);

const guest = fill(await readFile(path.join(here, "src/guest.html"), "utf8"), "guest.html", {
  TITLE: title, STYLE: style, BODY: body, SCRIPT: guestScript,
});
const guestBytes = Buffer.from(guest, "utf8");
if (guestBytes.length > 8 * 1024 * 1024) fail("the restricted guest exceeds the 8 MiB mount budget");
const artifact = { revision: commit, sha256: sha(guestBytes), "max-bytes": guestBytes.length };

const csp = [
  "default-src 'none'",
  `script-src 'self' ${shaB64(preambleText)} ${shaB64(guestScript)} 'wasm-unsafe-eval'`,
  `style-src 'self' ${shaB64(style)}`,
  "img-src 'self' data:",
  "font-src 'self'",
  connect,
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const confPath = path.join(here, "src-tauri/tauri.conf.json");
const conf = JSON.parse(await readFile(confPath, "utf8"));
if (conf.app?.security?.csp !== csp) {
  if (process.env.WRITE_CSP === "1") {
    conf.app.security.csp = csp;
    await writeFile(confPath, JSON.stringify(conf, null, 2) + "\n");
    console.error("tauri build: wrote src-tauri/tauri.conf.json csp; re-run to verify");
    process.exit(2);
  }
  fail("src-tauri/tauri.conf.json csp differs from the derived policy; re-run with WRITE_CSP=1");
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "vendor"), { recursive: true });
await writeFile(path.join(out, "index.html"),
  fill(await readFile(path.join(here, "src/host.html"), "utf8"), "host.html", { CSP: csp, TITLE: title }));
await cp(path.join(here, "src/host.js"), path.join(out, "host.js"));
await cp(path.join(here, "src/host.css"), path.join(out, "host.css"));
await cp(path.join(here, "vendor/kotoba-client-runtime.js"), path.join(out, "vendor/kotoba-client-runtime.js"));
await cp(path.join(here, "vendor/kotoba-client-consent.css"), path.join(out, "vendor/kotoba-client-consent.css"));
await writeFile(path.join(out, "host-data.js"),
  `export default ${JSON.stringify({ descriptor, artifact, guest })};\n`);
await writeFile(path.join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");

const files = {};
const walk = async (dir) => {
  for (const entry of await readdir(path.join(out, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel);
    else files[rel] = sha(await readFile(path.join(out, rel)));
  }
};
await walk("");
delete files["release.json"];
await writeFile(path.join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: "cloud.itonami.live", tauri: "3.0.0-alpha.6",
  profile: descriptor.profile, runtimePins: pins, files, guest: artifact,
}, null, 2) + "\n");
console.log(`Live restricted frontend: ${Object.keys(files).length} files; ${connect}; guest ${guestBytes.length} bytes`);
