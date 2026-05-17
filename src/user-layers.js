import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import shpjs from "shpjs";

const LAYER_COLORS = [
  "#3B82F6", // blue
  "#EF4444", // red
  "#F59E0B", // amber
  "#10B981", // green
  "#8B5CF6", // purple
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
];

let colorIndex = 0;

export function nextLayerColor() {
  return LAYER_COLORS[colorIndex++ % LAYER_COLORS.length];
}

/**
 * Parse a .kml file (File object) → GeoJSON FeatureCollection.
 * Throws a descriptive Error if the file is invalid or has no features.
 */
export async function parseKml(file) {
  const text = await file.text();
  let dom;
  try {
    dom = new DOMParser().parseFromString(text, "text/xml");
  } catch {
    throw new Error("Could not parse KML file as XML.");
  }
  const parseError = dom.querySelector("parsererror");
  if (parseError) {
    throw new Error("KML file contains invalid XML.");
  }
  const geojson = kmlToGeoJson(dom);
  if (!geojson?.features?.length) {
    throw new Error("No geographic features found in the KML file.");
  }
  return geojson;
}

/**
 * Parse a Shapefile ZIP (File object) → GeoJSON FeatureCollection.
 * The ZIP must contain at minimum a .shp and .dbf file.
 * Throws a descriptive Error if the file cannot be read.
 */
export async function parseShapefile(file) {
  const buffer = await file.arrayBuffer();
  let result;
  try {
    result = await shpjs(buffer);
  } catch (err) {
    throw new Error(`Could not read shapefile ZIP: ${err.message ?? "unknown error"}`);
  }
  // shpjs may return a FeatureCollection or an array of them (multi-layer ZIP)
  let geojson;
  if (Array.isArray(result)) {
    const features = result.flatMap((fc) => fc.features ?? []);
    geojson = { type: "FeatureCollection", features };
  } else {
    geojson = result;
  }
  if (!geojson?.features?.length) {
    throw new Error("No geographic features found in the shapefile.");
  }
  return geojson;
}
