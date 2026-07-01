export function reanchorSkylinesToMovedSkids(features, project, movedFeatures) {
  const anchors = movedSkidAnchors(features, project, movedFeatures);
  if (!anchors.length) return { features, changed: false };

  let changed = false;
  const nextFeatures = features.map((feature) => {
    if (feature?.geometry?.type !== "LineString" || feature.geometry.coordinates.length < 2) return feature;

    const coordinates = feature.geometry.coordinates.map((coordinate) => [...coordinate]);
    const firstIndex = 0;
    const lastIndex = coordinates.length - 1;
    let featureChanged = false;

    anchors.forEach(({ previous, next }) => {
      if (sameCoordinate(coordinates[firstIndex], previous)) {
        coordinates[firstIndex] = [...next];
        featureChanged = true;
      }
      if (sameCoordinate(coordinates[lastIndex], previous)) {
        coordinates[lastIndex] = [...next];
        featureChanged = true;
      }
    });

    if (!featureChanged) return feature;
    changed = true;
    return {
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates
      }
    };
  });

  return { features: nextFeatures, changed };
}

function movedSkidAnchors(features, project, movedFeatures) {
  return (movedFeatures ?? []).flatMap((feature) => {
    if (feature?.geometry?.type !== "Point") return [];
    const skidIndex = skidIndexForFeature(features, feature);
    if (!Number.isInteger(skidIndex) || skidIndex < 0) return [];

    const previous = previousSkidCoordinate(project, skidIndex);
    const next = feature.geometry.coordinates;
    if (!isLngLat(previous) || !isLngLat(next)) return [];
    if (sameCoordinate(previous, next)) return [];

    return [{ previous, next }];
  });
}

function skidIndexForFeature(features, feature) {
  if (feature.properties?.role === "skid") {
    const skidIndex = Number(feature.properties?.skidId) - 1;
    if (Number.isInteger(skidIndex) && skidIndex >= 0) return skidIndex;
  }

  const drawPoints = (features ?? []).filter((candidate) => candidate?.geometry?.type === "Point");
  const pointIndex = drawPoints.findIndex((candidate) => candidate === feature || candidate.id === feature.id);
  return pointIndex >= 0 ? pointIndex : -1;
}

function previousSkidCoordinate(project, skidIndex) {
  const skids = Array.isArray(project?.skids) ? project.skids : [];
  if (isLngLat(skids[skidIndex])) return skids[skidIndex];
  if (skidIndex === 0 && isLngLat(project?.skid)) return project.skid;
  return null;
}

function isLngLat(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1]);
}

function sameCoordinate(a, b) {
  return isLngLat(a) && isLngLat(b) && Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}