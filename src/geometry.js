const EARTH_RADIUS_METRES = 6371000;

export function polygonAreaSquareMetres(polygon) {
  if (!Array.isArray(polygon?.[0]) || polygon[0].length < 4) return 0;
  const [outerRing, ...holes] = polygon;
  const outerArea = Math.abs(ringAreaSquareMetres(outerRing));
  const holesArea = holes.reduce((total, ring) => total + Math.abs(ringAreaSquareMetres(ring)), 0);
  return Math.max(0, outerArea - holesArea);
}

export function formatArea(squareMetres) {
  const area = Number(squareMetres);
  if (!Number.isFinite(area) || area <= 0) return "Not drawn";
  const hectares = area / 10000;
  if (hectares >= 10) return `${hectares.toFixed(1)} ha`;
  if (hectares >= 1) return `${hectares.toFixed(2)} ha`;
  return `${Math.round(area)} m2`;
}

export function polygonCentroid(polygon) {
  const ring = polygon?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  const coordinates = ring.filter((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2);
  if (!coordinates.length) return null;

  const totals = coordinates.reduce((sum, coordinate) => ({
    longitude: sum.longitude + coordinate[0],
    latitude: sum.latitude + coordinate[1]
  }), { longitude: 0, latitude: 0 });

  return [totals.longitude / coordinates.length, totals.latitude / coordinates.length];
}

function ringAreaSquareMetres(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const origin = ring[0];
  const originLat = toRadians(origin[1]);
  const projected = ring.map(([longitude, latitude]) => {
    const x = EARTH_RADIUS_METRES * toRadians(longitude - origin[0]) * Math.cos(originLat);
    const y = EARTH_RADIUS_METRES * toRadians(latitude - origin[1]);
    return [x, y];
  });

  return projected.slice(0, -1).reduce((area, point, index) => {
    const next = projected[index + 1];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}
