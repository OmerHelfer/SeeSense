import React, { useRef, useEffect, useState, useCallback } from 'react';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

/**
 * CameraView
 *
 * Renders the rear-facing camera feed with:
 * - Pinch-to-zoom via PointerEvents (tries native MediaTrack zoom first,
 *   falls back to CSS transform + adjusted canvas crop)
 * - Periodic frame capture (640×640 JPEG) at 250 ms intervals when active
 *
 * Props:
 *   isActive       {boolean}   Start/stop the camera
 *   onFrameCapture {function}  Called with a base64 JPEG data-URL every 250 ms
 */
const CameraView = ({ isActive, onFrameCapture }) => {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);  // active MediaStream

  const [zoom, setZoom]           = useState(1);
  const zoomRef                   = useRef(1);   // mirror for use inside intervals/callbacks

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
    onFrameCapture?.(canvas.toDataURL('image/jpeg', 0.7));
  }, [onFrameCapture]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(captureFrame, 250);
    return () => clearInterval(id);
  }, [isActive, captureFrame]);

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
        style={{
          transform:       `scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      />
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