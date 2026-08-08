import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { getJpegQuality } from '../config/streamConfig';
import { recordClientStage } from '../services/clientMetrics';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

const DEFAULT_FRAME_SIZE = 640;

const CAPTURE_POLL_HZ = 120;

const BOX_COLORS = { high: '#ff3b30', low: '#eab308', none: '#00f0ff' };

const CameraView = ({ isActive, onFrameCapture, shouldCapture, inputSize = DEFAULT_FRAME_SIZE, detections = [] }) => {
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const streamRef    = useRef(null);

  const frameSize    = Math.max(1, Math.round(inputSize) || DEFAULT_FRAME_SIZE);
  const frameSizeRef = useRef(frameSize);
  useEffect(() => { frameSizeRef.current = frameSize; }, [frameSize]);

  const shouldCaptureRef = useRef(shouldCapture);
  useEffect(() => { shouldCaptureRef.current = shouldCapture; }, [shouldCapture]);

  const [zoom, setZoom]           = useState(1);
  const zoomRef                   = useRef(1);

  const [videoSize, setVideoSize]         = useState({ w: 0, h: 0 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const pointersRef = useRef(new Map());
  const pinchRef    = useRef({ initialDist: null, initialZoom: 1 });


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


  const applyNativeZoom = useCallback((z) => {
    const track        = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const capabilities = track.getCapabilities?.();
    if (!capabilities?.zoom) return;
    const clamped = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, z));
    track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(() => {});
  }, []);


  const captureFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    if (shouldCaptureRef.current && !shouldCaptureRef.current()) return;

    const ctx      = canvas.getContext('2d');
    const baseSize = Math.min(video.videoWidth, video.videoHeight);
    const size     = frameSizeRef.current;

    if (canvas.width !== size || canvas.height !== size) {
      canvas.width  = size;
      canvas.height = size;
    }

    const cropSize = baseSize / zoomRef.current;
    const startX   = (video.videoWidth  - cropSize) / 2;
    const startY   = (video.videoHeight - cropSize) / 2;

    // tCap also opens the end-to-end latency clock: it is the earliest moment this
    // frame exists as data, so it is the honest start of the pipeline the user
    // experiences. It is handed downstream and closed only after the alert is
    // spoken/vibrated (see VisionStream.completeE2E).
    const tCap = performance.now();
    ctx.drawImage(video, startX, startY, cropSize, cropSize, 0, 0, size, size);
    recordClientStage('capture', performance.now() - tCap);

    const tEnc = performance.now();
    canvas.toBlob(
      (blob) => {
        recordClientStage('encode', performance.now() - tEnc);
        if (blob) onFrameCapture?.(blob, tCap);
      },
      'image/jpeg',
      getJpegQuality(),
    );
  }, [onFrameCapture]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(captureFrame, 1000 / CAPTURE_POLL_HZ);
    return () => clearInterval(id);
  }, [isActive, captureFrame]);


  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const overlayBoxes = useMemo(() => {
    const { w: vW, h: vH } = videoSize;
    const { w: cW, h: cH } = containerSize;
    if (!vW || !vH || !cW || !cH || detections.length === 0) return [];

    const baseSize   = Math.min(vW, vH);
    const coverScale = Math.max(cW / vW, cH / vH);
    const squareSide = baseSize * coverScale;
    const squareLeft = (cW - squareSide) / 2;
    const squareTop  = (cH - squareSide) / 2;
    const s          = squareSide / frameSize;

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
  }, [detections, videoSize, containerSize, frameSize]);


  const getPinchDist = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return null;
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  };

  const handlePointerDown = (e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size < 2) return;

    const dist = getPinchDist();

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
      pinchRef.current.initialDist = null;
    }
  };


  return (
    <div
      ref={containerRef}
      className="camera-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
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
            const above = b.y > font * 1.4;
            const ty    = above ? b.y - pad : b.y + font + pad;
            const tx    = b.x + b.w / 2;
            return (
              <g key={b.key}>
                <rect
                  x={b.x} y={b.y} width={b.w} height={b.h}
                  rx={4 / zoom}
                  fill={color} fillOpacity={0.08}
                  stroke={color} strokeWidth={2 / zoom}
                />
                <text
                  x={tx} y={ty}
                  textAnchor="middle"
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