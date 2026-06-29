import { DEFAULT_ASSUMPTIONS } from "./clearance.js";
import { TERRAIN_MODES, terrainSourceNote } from "./terrain.js";

const STORAGE_KEY = "schroder-hill-cable-project";

export function createInitialState() {
  return {
    projectName: "",
    skid: null,
    skids: [],
    settingPolygon: null,
    skylines: [],
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    assumptionsTouched: false,
    baseMapMode: "google-satellite",
    terrainMode: TERRAIN_MODES.MAPBOX,
    terrainStatus: {
      source: terrainSourceNote(TERRAIN_MODES.MAPBOX),
      warning: ""
    },
    results: [],
    userLayers: [],
    geopdfOverlays: [],
    geopdfImport: {
      loading: false,
      error: "",
      message: ""
    },
    updatedAt: null
  };
}

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const skids = normalizeSkids(saved);
    return {
      ...createInitialState(),
      ...saved,
      skid: skids.at(-1) ?? null,
      skids,
      projectName: saved?.projectName === "Schroder Hill screening" ? "" : saved?.projectName ?? ""
    };
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}

function normalizeSkids(project) {
  const skids = Array.isArray(project?.skids) ? project.skids.filter(isLngLat).map((coordinate) => [...coordinate]) : [];
  if (!skids.length && isLngLat(project?.skid)) skids.push([...project.skid]);
  return skids;
}

function isLngLat(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1]);
}
