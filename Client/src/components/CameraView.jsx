import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { JPEG_QUALITY } from '../config/streamConfig';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

// Frames are captured and analysed at this fixed square size (see captureFrame
// below and the server's letterbox resize). YOLO bbox coords arrive in this space.
const FRAME_SIZE = 640;

// Box colour per danger level — mirrors the app's alert palette (red / amber / cyan HUD).
const BOX_COLORS = { high: '#ff3b30', low: '#eab308', none: '#00f0ff' };

/**
 * CameraView
 *
 * Renders the rear-facing camera feed with:
 * - Pinch-to-zoom via PointerEvents (tries native MediaTrack zoom first,
 *   falls back to CSS transform + adjusted canvas crop)
 * - Periodic frame capture (640×640 JPEG) at the configured capture rate
 * - Real-time detection overlay (bounding boxes + class/confidence labels)
 *
 * Props:
 *   isActive       {boolean}   Start/stop the camera
 *   onFrameCapture {function}  Called with a base64 JPEG data-URL each capture tick
 *   captureFps     {number}    Target capture rate (frames/sec); driven by the
 *                              server's TARGET_FPS. Defaults to 4 until the server
 *                              reports its value on WebSocket connect.
 *   detections     {Array}     Latest detections to draw, each { bbox:[x1,y1,x2,y2],
 *                              class_name, confidence, alert_level, motion } in 640×640 space
 *
 * Frame compression is fixed by JPEG_QUALITY in config/streamConfig.js.
 */
const CameraView = ({ isActive, onFrameCapture, captureFps = 4, detections = [] }) => {
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const streamRef    = useRef(null);  // active MediaStream

  const [zoom, setZoom]           = useState(1);
  const zoomRef                   = useRef(1);   // mirror for use inside intervals/callbacks

  // Geometry needed to map 640×640 detection coords onto the displayed video
  const [videoSize, setVideoSize]         = useState({ w: 0, h: 0 }); // intrinsic video pixels
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 }); // on-screen viewport pixels

  // Pinch tracking
  const pointersRef = useRef(new Map()); // pointerId → {x, y}
  const pinchRef    = useRef({ initialDist: null, initialZoom: 1 });

  // ── Camera lifecycle ──────────────────────────────

  useEffect(() => {
    if (isActive) {
      startCamera();
    } else {
      stopCamera();
      setZoom(1);
      zoomRef.current = 1;
    }
    return () => stopCamera();
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width:  { ideal: 1280 },
          height: { ideal: 720  },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      console.error('Camera access error:', err);
      alert('חובה לאשר גישה למצלמה כדי שהמערכת תעבוד');
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  // ── Native zoom (MediaTrack constraint) ─────────

  /**
   * Try to apply zoom via the camera hardware (better quality than CSS scale).
   * Silently ignored if the device/browser doesn't support the zoom constraint.
   */
  const applyNativeZoom = useCallback((z) => {
    const track        = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const capabilities = track.getCapabilities?.();
    if (!capabilities?.zoom) return;
    const clamped = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, z));
    track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(() => {});
  }, []);

  // ── Frame capture ────────────────────────────────

  /**
   * Captures a 640×640 JPEG from the current video frame.
   * The canvas crop is adjusted for the current zoom level so that the
   * extracted region matches what the user actually sees on screen.
   */
  const captureFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    const ctx      = canvas.getContext('2d');
    const baseSize = Math.min(video.videoWidth, video.videoHeight);

    // A higher zoom means we sample a smaller central region of the raw video
    const cropSize = baseSize / zoomRef.current;
    const startX   = (video.videoWidth  - cropSize) / 2;
    const startY   = (video.videoHeight - cropSize) / 2;

    ctx.drawImage(video, startX, startY, cropSize, cropSize, 0, 0, 640, 640);
    onFrameCapture?.(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
  }, [onFrameCapture]);

  useEffect(() => {
    if (!isActive) return;
    // Capture interval derived from the server-configured target FPS.
    // (Clamped to a sane range so a bad config value can't break capture.)
    const fps = Math.max(1, Math.min(30, captureFps || 4));
    const id = setInterval(captureFrame, 1000 / fps);
    return () => clearInterval(id);
  }, [isActive, captureFrame, captureFps]);

  // ── Detection overlay geometry ───────────────────

  /** Record the intrinsic video resolution once the stream metadata is ready. */
  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
  }, []);

  /** Keep the container's on-screen pixel size in sync (responsive layout). */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Map each detection's 640×640 bbox into on-screen (pre-zoom) container pixels.
   *
   * The captured frame is the centre square (side = min(videoW, videoH)) of the raw
   * video. With object-fit: cover the video is scaled uniformly by `coverScale` and
   * centred, so that centre square becomes a centred square of side `squareSide` in
   * container coords. The zoom is applied separately via a CSS transform on the SVG
   * (matching the video element), so we intentionally map in the *pre-zoom* space.
   */
  const overlayBoxes = useMemo(() => {
    const { w: vW, h: vH } = videoSize;
    const { w: cW, h: cH } = containerSize;
    if (!vW || !vH || !cW || !cH || detections.length === 0) return [];

    const baseSize   = Math.min(vW, vH);
    const coverScale = Math.max(cW / vW, cH / vH);
    const squareSide = baseSize * coverScale;
    const squareLeft = (cW - squareSide) / 2;
    const squareTop  = (cH - squareSide) / 2;
    const s          = squareSide / FRAME_SIZE; // 640-space → container px

    return detections.map((d, i) => {
      const [x1, y1, x2, y2] = d.bbox ?? [0, 0, 0, 0];
      return {
        key:   d.motion?.track_id != null && d.motion.track_id >= 0 ? `t${d.motion.track_id}` : `i${i}`,
        x:     squareLeft + x1 * s,
        y:     squareTop  + y1 * s,
        w:     Math.max(0, (x2 - x1) * s),
        h:     Math.max(0, (y2 - y1) * s),
        label: `${d.class_name ?? 'object'} ${Math.round((d.confidence ?? 0) * 100)}%`,
        level: d.alert_level ?? 'none',
      };
    });
  }, [detections, videoSize, containerSize]);

  // ── Pinch-to-zoom (PointerEvents) ───────────────

  const getPinchDist = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return null;
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  };

  const handlePointerDown = (e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture so we keep receiving events even if the pointer leaves the element
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size < 2) return; // single-finger drag — ignore

    const dist = getPinchDist();

    // First frame of a new pinch gesture — record baseline
    if (pinchRef.current.initialDist === null) {
      pinchRef.current = { initialDist: dist, initialZoom: zoomRef.current };
      return;
    }

    const newZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, pinchRef.current.initialZoom * (dist / pinchRef.current.initialDist)),
    );

    zoomRef.current = newZoom;
    setZoom(newZoom);
    applyNativeZoom(newZoom);
  };

  const handlePointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current.initialDist = null; // reset baseline for next gesture
    }
  };

  // ── Render ───────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="camera-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }} /* prevent browser scroll/zoom interfering */
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="video-feed"
        onLoadedMetadata={handleLoadedMetadata}
        style={{
          transform:       `scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      />

      {/* ── Detection overlay ──
          Bounding boxes are drawn in the same (pre-zoom) coordinate space as the
          video and carry the identical CSS scale(zoom), so they track the feed at
          any zoom level. Line/text sizes are divided by zoom to stay screen-constant. */}
      {overlayBoxes.length > 0 && (
        <svg
          className="detection-overlay"
          width={containerSize.w}
          height={containerSize.h}
          style={{
            transform:       `scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          aria-hidden="true"
        >
          {overlayBoxes.map((b) => {
            const color = BOX_COLORS[b.level] ?? BOX_COLORS.none;
            const font  = 13 / zoom;
            const pad   = 4 / zoom;
            const above = b.y > font * 1.4;                 // keep label on-screen
            const ty    = above ? b.y - pad : b.y + font + pad;
            return (
              <g key={b.key}>
                <rect
                  x={b.x} y={b.y} width={b.w} height={b.h}
                  rx={4 / zoom}
                  fill={color} fillOpacity={0.08}
                  stroke={color} strokeWidth={2 / zoom}
                />
                <text
                  x={b.x + pad} y={ty}
                  fontSize={font}
                  fontWeight="700"
                  fill={color}
                  stroke="rgba(0,0,0,0.85)"
                  strokeWidth={3 / zoom}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                >
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* Hidden canvas used for frame extraction */}
      <canvas
        ref={canvasRef}
        width="640"
        height="640"
        style={{ display: 'none' }}
      />
    </div>
  );
};

export default CameraView;