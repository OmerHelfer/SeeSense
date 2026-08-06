/* ═══════════════════════════════════════════════════
   streamConfig.js
   Client-side streaming tunables. Change these numbers to
   trade off image quality vs. upload size / speed.
   ═══════════════════════════════════════════════════ */

/**
 * How hard to compress each captured frame before uploading it, as a percentage.
 *
 *     0   = no compression   → sharpest image, largest file, best detection, slowest upload
 *   100   = full compression → blockiest image, smallest file, worst detection, fastest upload
 *
 * This is the ONE knob to tune frame compression. It maps to the canvas JPEG
 * quality argument:  quality = 1 - COMPRESSION_PERCENT / 100.
 */
export const COMPRESSION_PERCENT = 75;

/** Canvas JPEG quality (0..1) derived from COMPRESSION_PERCENT. */
export const JPEG_QUALITY = Math.max(0, Math.min(1, 1 - COMPRESSION_PERCENT / 100));

/**
 * Square input size (pixels) for capture + detection, e.g. 640 → 640×640.
 *
 * This is the biggest performance lever: the server runs YOLO at this size, so
 * smaller = faster inference AND smaller uploads.
 *   640 = default (most detail / best on small & far objects)
 *   512 / 416 / 320 = progressively faster, but the model sees less detail
 *                     (may miss small/distant objects).
 *
 * Best to use a multiple of 32 (640, 512, 416, 384, 320); other values still
 * work but the model rounds internally. The server clamps this to a safe range
 * and reports the value it actually used back on connect, so client + server
 * always agree on the coordinate space.
 */
export const INPUT_SIZE = 640;

/**
 * Pipeline depth — how many frames may be "in flight" (sent, awaiting a result)
 * at once.
 *
 * THIS IS THE ONLY CONTROL ON THE SEND RATE. There is no frame-rate setting
 * anywhere, on the client or the server (a TARGET_FPS/MAX_FPS existed until
 * 2026-08 and was removed: it was a second, interacting limiter that held the
 * real rate below what the pipeline could do). The client sends the next frame
 * the moment a reply frees a slot, so the rate settles at whatever the network
 * and the server can actually sustain.
 *
 *     throughput λ = min( 1/S , depth/R₀ )      S  = server time per frame
 *     latency    W = depth / λ                  R₀ = round-trip with no queueing
 *
 * Two regimes, and which one you are in decides whether raising this helps:
 *   - depth/R₀ < 1/S  → server idles waiting for frames. More depth fills dead
 *                       time: FPS rises, latency stays ~R₀. Free.
 *   - depth/R₀ > 1/S  → server never idles. Extra frames only queue: FPS is
 *                       pinned at 1/S and each added frame adds S to everyone's
 *                       wait. Pure latency, no gain.
 * The crossover is depth ≈ R₀/S. Past it you are buying delay.
 *
 * Measured 2026-08-06 (server ~16.4ms/frame ⇒ ~61 FPS ceiling, R₀ ~120ms):
 *   6  → 50 FPS, 120ms      7  → 53 FPS, 133ms
 *   10 → 60 FPS, 166ms      20 → 60 FPS, 332ms  ← same FPS, double the delay
 *
 * Latency is the safety number here, not FPS: at 50km/h a car covers 1.4m per
 * 100ms, and above ~25 FPS extra frames buy almost nothing (the 0.8s approach
 * window is already oversampled). Read ניצולת שרת on /admin/status — while it is
 * under ~70% there is headroom; near 100% only latency is left to buy.
 */
export const MAX_INFLIGHT = 6;