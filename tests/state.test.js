import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSUMPTIONS } from "../src/clearance.js";
import { clearState, createInitialState, loadState } from "../src/state.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fresh project state", () => {
  it("contains no project geometry, results, or imported maps", () => {
    const state = createInitialState();

    expect(state).toMatchObject({
      projectName: "",
      skid: null,
      skids: [],
      settingPolygon: null,
      skylines: [],
      results: [],
      userLayers: [],
      geopdfOverlays: [],
      geotiffMeta: null,
      geotiffError: null,
      baseMapMode: "google-satellite",
      assumptions: DEFAULT_ASSUMPTIONS,
      assumptionsTouched: false,
      updatedAt: null
    });
    expect(state.geopdfImport).toEqual({ loading: false, error: "", message: "" });
  });

  it("returns independent mutable collections for each project", () => {
    const first = createInitialState();
    const second = createInitialState();

    first.skylines.push({ id: "1", coordinates: [] });
    first.assumptions.haulerName = "Changed";

    expect(second.skylines).toEqual([]);
    expect(second.assumptions).toEqual(DEFAULT_ASSUMPTIONS);
  });

  it("clears persistence and normalizes an invalid saved basemap", () => {
    const localStorage = {
      getItem: vi.fn(() => JSON.stringify({ baseMapMode: "obsolete-map" })),
      removeItem: vi.fn()
    };
    vi.stubGlobal("localStorage", localStorage);

    expect(loadState().baseMapMode).toBe("google-satellite");
    clearState();

    expect(localStorage.removeItem).toHaveBeenCalledWith("schroder-hill-cable-project");
  });
});
