import React, { useState } from 'react';
import CameraView from '../components/CameraView';
import { useAuth } from '../context/AuthContext';
import { LogOut, Settings as SettingsIcon, Play, Square } from 'lucide-react';

const Dashboard = () => {
  const { logout, user } = useAuth();
  const [isDetecting, setIsDetecting] = useState(false);

  const handleFrame = (imageData) => {
    // This will be connected to /analyze_frame API
    console.log("Frame ready for analysis");
  };

  const toggleDetection = () => {
    const newState = !isDetecting;
    setIsDetecting(newState);
    
    // Haptic feedback for mobile
    if (navigator.vibrate) {
      navigator.vibrate(newState ? [100, 50, 100] : 60);
    }
  };

  return (
    <div className="dashboard-page">
      <nav className="top-nav">
        <button onClick={logout} className="icon-button-large">
          <LogOut size={28} />
        </button>
        <h2 className="app-title">SeeSense</h2>
        <button className="icon-button-large">
          <SettingsIcon size={28} />
        </button>
      </nav>

      <div className="main-viewer">
        <CameraView 
          isActive={isDetecting} 
          onFrameCapture={handleFrame} 
        />
        
        <div className="camera-status-overlay">
          <div className={`status-dot ${isDetecting ? 'active' : 'idle'}`}></div>
          <span>{isDetecting ? 'סורק עכשיו' : 'מוכן לסריקה'}</span>
        </div>

        <div className="alignment-overlay">
          {/* Alignment brackets will be rendered here based on sensors */}
        </div>
      </div>

      <div className="controls-area">
        <button 
          className={`main-trigger ${isDetecting ? 'active' : ''}`}
          onClick={toggleDetection}
        >
          {isDetecting ? (
            <>
              <Square size={32} fill="white" />
              עצור זיהוי
            </>
          ) : (
            <>
              <Play size={32} fill="black" />
              התחל סריקה
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default Dashboard;