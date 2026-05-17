import { DEFAULT_ASSUMPTIONS } from "./clearance.js";
import { TERRAIN_MODES, terrainSourceNote } from "./terrain.js";

const STORAGE_KEY = "schroder-hill-cable-project";

export function createInitialState() {
  return {
    projectName: "",
    skid: null,
    settingPolygon: null,
    skylines: [],
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    baseMapMode: "outdoors",
    terrainMode: TERRAIN_MODES.MAPBOX,
    terrainStatus: {
      source: terrainSourceNote(TERRAIN_MODES.MAPBOX),
      warning: ""
    },
    results: [],
    userLayers: [],
    updatedAt: null
  };
}

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      ...createInitialState(),
      ...saved,
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
