import { useState, useEffect, useCallback, useRef } from 'react';


const ALIGNMENT_THRESHOLD = 15;

const useOrientation = () => {
  const [orientation, setOrientation]       = useState({ beta: 90, gamma: 0 });
  const [permissionState, setPermissionState] = useState('idle');
  const listenerAttached                    = useRef(false);

  const handleEvent = useCallback((e) => {
    setOrientation({
      beta:  e.beta  ?? 90,
      gamma: e.gamma ?? 0,
    });
  }, []);

  const attachListener = useCallback(() => {
    if (!listenerAttached.current) {
      window.addEventListener('deviceorientation', handleEvent);
      listenerAttached.current = true;
    }
  }, [handleEvent]);

  useEffect(() => {
    const needsPermission =
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';

    if (!needsPermission) {
      attachListener();
      setPermissionState('granted');
    }

    return () => {
      window.removeEventListener('deviceorientation', handleEvent);
      listenerAttached.current = false;
    };
  }, [attachListener, handleEvent]);

  const requestPermission = useCallback(async () => {
    if (permissionState === 'granted') return;

    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result === 'granted') {
          attachListener();
          setPermissionState('granted');
        } else {
          setPermissionState('denied');
        }
      } catch {
        setPermissionState('denied');
      }
    } else {
      attachListener();
      setPermissionState('granted');
    }
  }, [permissionState, attachListener]);

  const isAligned = Math.abs((orientation.beta ?? 90) - 90) <= ALIGNMENT_THRESHOLD;

  return {
    beta:            orientation.beta,
    gamma:           orientation.gamma,
    isAligned,
    permissionState,
    requestPermission,
  };
};

export default useOrientation;
