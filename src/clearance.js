export const DEFAULT_ASSUMPTIONS = {
  haulerName: "",
  landingTowerPreset: "90",
  landingTowerHeight: 27.432,
  tailholdHeight: 2,
  minimumClearance: 2,
  manualSagAllowance: 0,
  sampleSpacing: 25,
  deflectionPercent: 6
};

export function distance(a, b) {
  const earthRadiusMetres = 6371000;
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const deltaLat = toRadians(b[1] - a[1]);
  const deltaLon = toRadians(b[0] - a[0]);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * earthRadiusMetres * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function lineLength(coordinates) {
  return coordinates.slice(1).reduce((total, point, index) => {
    return total + distance(coordinates[index], point);
  }, 0);
}

export function interpolateLine(coordinates, spacing) {
  const length = lineLength(coordinates);
  const sampleCount = Math.max(2, Math.floor(length / Math.max(1, spacing)) + 1);
  const samples = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const target = i === sampleCount - 1 ? length : (length * i) / (sampleCount - 1);
    samples.push(pointAtDistance(coordinates, target, length));
  }

  return samples;
}

function pointAtDistance(coordinates, targetDistance, totalLength) {
  if (targetDistance <= 0) return { coordinate: coordinates[0], distanceAlong: 0, ratio: 0 };
  if (targetDistance >= totalLength) {
    return { coordinate: coordinates.at(-1), distanceAlong: totalLength, ratio: 1 };
  }

  let travelled = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const start = coordinates[i];
    const end = coordinates[i + 1];
    const segmentLength = distance(start, end);
    if (travelled + segmentLength >= targetDistance) {
      const ratio = (targetDistance - travelled) / segmentLength;
      return {
        coordinate: [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio
        ],
        distanceAlong: targetDistance,
        ratio: totalLength === 0 ? 0 : targetDistance / totalLength
      };
    }
    travelled += segmentLength;
  }

  return { coordinate: coordinates.at(-1), distanceAlong: totalLength, ratio: 1 };
}

export async function calculateSkyline(skyline, assumptions, terrainProvider) {
  const merged = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  const coordinates = skyline.coordinates ?? [];
  const length = lineLength(coordinates);
  const samples = interpolateLine(coordinates, Number(merged.sampleSpacing));
  const elevations = await terrainProvider.sampleLine(samples.map((sample) => sample.coordinate));

  const landingGround = elevations[0] ?? 0;
  const tailholdGround = elevations.at(-1) ?? landingGround;
  const deflectionPercent = Number(merged.deflectionPercent || 0);
  const maxSag = length * (deflectionPercent / 100);
  const classifiedSamples = samples.map((sample, index) => {
    const chordElevation =
      landingGround +
      Number(merged.landingTowerHeight) +
      (tailholdGround + Number(merged.tailholdHeight) - (landingGround + Number(merged.landingTowerHeight))) *
        sample.ratio;
    const sagAtPoint = maxSag * 4 * sample.ratio * (1 - sample.ratio);
    const skylineElevation = chordElevation - sagAtPoint - Number(merged.manualSagAllowance || 0);
    const groundElevation = elevations[index] ?? 0;
    const clearance = skylineElevation - groundElevation;
    const status = clearance >= Number(merged.minimumClearance) ? "green" : "red";

    return {
      ...sample,
      distanceAlongLine: sample.distanceAlong,
      longitude: sample.coordinate[0],
      latitude: sample.coordinate[1],
      chordElevation,
      sagAtPoint,
      skylineElevation,
      cableElevation: skylineElevation,
      groundElevation,
      clearance,
      status
    };
  });

  const greenCount = classifiedSamples.filter((sample) => sample.status === "green").length;
  const redCount = classifiedSamples.length - greenCount;
  const minClearance = Math.min(...classifiedSamples.map((sample) => sample.clearance));
  const percentGreen = classifiedSamples.length ? (greenCount / classifiedSamples.length) * 100 : 0;
  const percentRed = 100 - percentGreen;

  return {
    id: skyline.id,
    length,
    minClearance,
    percentGreen,
    percentRed,
    pass: redCount === 0,
    deflectionPercent,
    maxSag,
    samples: classifiedSamples,
    notes: buildNotes(merged, minClearance, redCount)
  };
}

export async function calculateProject(skylines, assumptions, terrainProvider) {
  return Promise.all(skylines.map((skyline) => calculateSkyline(skyline, assumptions, terrainProvider)));
}

function buildNotes(assumptions, minClearance, redCount) {
  const notes = ["This prototype does not calculate true rope tension, safe working load, or cable mechanics."];
  if (redCount > 0) notes.push("One or more samples are below minimum required clearance.");
  if (minClearance <= 0) notes.push("Estimated cable intersects or drops below ground at one or more samples.");
  if (Number(assumptions.deflectionPercent) > 0) notes.push("User-defined geometric deflection applied to the skyline profile.");
  if (Number(assumptions.manualSagAllowance) > 0) notes.push("Manual sag allowance applied after geometric deflection.");
  return notes;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}
