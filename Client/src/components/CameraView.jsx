import React, { useRef, useEffect } from 'react';

const CameraView = ({ onFrameCapture, isActive }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    let stream = null;

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { 
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Error accessing camera:", err);
        alert("חובה לאשר גישה למצלמה כדי שהמערכת תעבוד");
      }
    };

    if (isActive) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => stopCamera();

    function stopCamera() {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    }
  }, [isActive]);

  const captureFrame = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    
    const size = Math.min(videoRef.current.videoWidth, videoRef.current.videoHeight);
    const startX = (videoRef.current.videoWidth - size) / 2;
    const startY = (videoRef.current.videoHeight - size) / 2;

    context.drawImage(
      videoRef.current, 
      startX, startY, size, size,
      0, 0, 640, 640
    );

    const imageData = canvas.toDataURL('image/jpeg', 0.8);
    onFrameCapture(imageData);
  };

  useEffect(() => {
    let interval;
    if (isActive) {
      interval = setInterval(captureFrame, 500);
    }
    return () => clearInterval(interval);
  }, [isActive]);

  return (
    <div className="camera-container">
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted 
        className="video-feed"
      />
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