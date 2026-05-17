import { describe, expect, it } from "vitest";
import {
  TERRAIN_MODES,
  defaultTerrainMode,
  terrainSourceNote,
  terrainWarningForMode
} from "../src/terrain.js";

describe("terrain provider selection", () => {
  it("defaults to Mapbox terrain when it is available", () => {
    expect(defaultTerrainMode(true)).toBe(TERRAIN_MODES.MAPBOX);
  });

  it("defaults to mock terrain when Mapbox terrain is unavailable", () => {
    expect(defaultTerrainMode(false)).toBe(TERRAIN_MODES.MOCK);
  });

  it("shows a real-assessment warning for mock terrain", () => {
    expect(terrainSourceNote(TERRAIN_MODES.MOCK)).toContain("mock terrain");
    expect(terrainWarningForMode(TERRAIN_MODES.MOCK, false)).toContain("not suitable");
  });

  it("warns when Mapbox terrain mode is selected but terrain is unavailable", () => {
    expect(terrainWarningForMode(TERRAIN_MODES.MAPBOX, false)).toContain("unavailable");
  });
});
