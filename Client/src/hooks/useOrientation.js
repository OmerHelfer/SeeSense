import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * useOrientation
 *
 * Reads DeviceOrientationEvent to track device tilt.
 * - On Android / desktop: listener is attached immediately (no permission needed).
 * - On iOS 13+: DeviceOrientationEvent.requestPermission() MUST be called
 *   from a user-gesture handler (e.g. a button click). Call requestPermission()
 *   from the button that starts scanning.
 *
 * "Aligned" = phone held vertically: beta is 90° ± THRESHOLD
 * (beta ≈ 90 means the device is upright and facing the user)
 */

const ALIGNMENT_THRESHOLD = 15; // degrees  →  75° – 105° is considered aligned

const useOrientation = () => {
  const [orientation, setOrientation]       = useState({ beta: 90, gamma: 0 });
  const [permissionState, setPermissionState] = useState('idle'); // idle | granted | denied
  const listenerAttached                    = useRef(false);

  const handleEvent = useCallback((e) => {
    setOrientation({
      beta:  e.beta  ?? 90,
      gamma: e.gamma ?? 0,
    });
  }, []);

  /** Attach the event listener (idempotent). */
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
      // Android, desktop, most non-iOS browsers — attach right away
      attachListener();
      setPermissionState('granted');
    }
    // iOS 13+: wait for explicit user gesture via requestPermission()

    return () => {
      window.removeEventListener('deviceorientation', handleEvent);
      listenerAttached.current = false;
    };
  }, [attachListener, handleEvent]);

  /**
   * Call this from a button-click handler (user gesture) to unlock the
   * gyroscope on iOS 13+. Safe to call multiple times (no-op if already granted).
   */
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
        // User dismissed the prompt or browser blocked it
        setPermissionState('denied');
      }
    } else {
      // Fallback: shouldn't reach here, but attach just in case
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
