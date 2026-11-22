// restricted-wasm-v1 host (KOTOBA-159). This page is the trusted shell: it
// holds the canonical runtime, checks the descriptor, verifies the guest
// document against the digest pinned at build time, and mounts it with
// mountRestrictedClientApp into an opaque-origin sandbox. The guest gets no
// operation: the descriptor declares none, so the broker refuses every call
// before any consent dialog. The host itself reads only ./host-data.js.
import { createClientConsentHost, createClientOperationBroker, mountRestrictedClientApp, verifyClientArtifact } from "./vendor/kotoba-client-runtime.js";
import host from "./host-data.js";

const container = document.getElementById("app");
const problem = document.getElementById("problem");
try {
  const consentHost = createClientConsentHost({ locale: "ja" });
  const broker = createClientOperationBroker({ runtime: host.descriptor, consentHost });
  const artifact = await verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact);
  await mountRestrictedClientApp({ artifact, container, broker });
} catch (error) {
  problem.hidden = false;
  problem.textContent = `起動できませんでした: ${error?.message ?? error}`;
}
