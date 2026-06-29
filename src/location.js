const DEFAULT_LOCATION_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 5000
};

export function geolocationSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.geolocation);
}

export function startLocationWatch({ onPosition, onError, options } = {}) {
  if (!geolocationSupported()) {
    onError?.({ kind: "unsupported", message: "Location is unavailable on this device/browser." });
    return () => {};
  }

  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      onPosition?.(normalizePosition(position));
    },
    (error) => {
      onError?.(normalizeError(error));
    },
    { ...DEFAULT_LOCATION_OPTIONS, ...(options ?? {}) }
  );

  return () => navigator.geolocation.clearWatch(watchId);
}

function normalizePosition(position) {
  return {
    lngLat: [position.coords.longitude, position.coords.latitude],
    accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    timestamp: Number(position.timestamp) || Date.now()
  };
}

function normalizeError(error) {
  const code = Number(error?.code);
  if (code === 1) {
    return {
      kind: "permission-denied",
      message: "Location permission denied. Allow access to see your blue dot."
    };
  }
  if (code === 2) {
    return {
      kind: "position-unavailable",
      message: "Unable to determine position. Move to an open area and try again."
    };
  }
  if (code === 3) {
    return {
      kind: "timeout",
      message: "Location request timed out. Waiting for a stronger GPS fix."
    };
  }
  return {
    kind: "unknown",
    message: "Location error. Try turning tracking off and on again."
  };
}
