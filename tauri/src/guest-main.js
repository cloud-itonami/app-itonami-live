// Offline guest main for the restricted live show (KOTOBA-159). The network
// edition opened a WebSocket to the room DO and bootstrapped room state over
// XRPC; the restricted guest has connect-src 'none', so the show runs the
// wasm demo only: cheers fire locally, presence stays at 1. WASM_B64 (the
// inlined live-v1 wasm) is defined just before this block by the build.
// Cheers and the HUD are wired before the wasm boots, so the page stays
// responsive even where the engine cannot compile the module.
;(function () {
  var initialized = false;
  function bytes() {
    var raw = atob(WASM_B64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  document.getElementById('enter').addEventListener('click', function () {
    if (initialized) return;
    initialized = true;
    try { initAudio(); } catch (e) { /* audio stays muted */ }
    document.getElementById('start').remove();
    document.getElementById('presence').textContent = 'viewers: 1';
    document.querySelectorAll('#cheers button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try { live_send_cheer(btn.dataset.kind, 1.0); } catch (e) { /* show not ready */ }
        var loud = document.getElementById('loud');
        var n = (Number(loud.textContent.split(': ')[1]) || 0) + 1;
        loud.textContent = 'cheers: ' + n.toFixed(0);
      });
    });
    var frames = 0;
    var lastSample = performance.now();
    var observedFps = 0;
    function tickFps() {
      frames += 1;
      requestAnimationFrame(tickFps);
    }
    requestAnimationFrame(tickFps);
    setInterval(function () {
      var now = performance.now();
      var elapsed = now - lastSample;
      if (elapsed > 0) {
        observedFps = (frames * 1000) / elapsed;
        frames = 0;
        lastSample = now;
      }
      var hud = window.__kami_hud_live;
      var fps = (hud && hud.fps) || observedFps;
      var backend = (hud && hud.backend) || 'WebGpu';
      document.getElementById('phase').textContent = fps.toFixed(0) + ' fps · ' + backend;
    }, 250);
    (async function boot() {
      try {
        await __wbg_init({ module_or_path: bytes() });
        await run_live_v1('gc');
      } catch (e) {
        document.getElementById('track').textContent = '起動できませんでした';
      }
    })();
  });
})();
