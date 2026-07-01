import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS } from "../src/clearance.js";
import { workflowModel } from "../src/ui.js";

const baseState = {
  skids: [],
  skid: null,
  skylines: [],
  results: [],
  geopdfOverlays: [],
  assumptions: { ...DEFAULT_ASSUMPTIONS },
  assumptionsTouched: false,
  isCalculating: false,
  terrainMode: "mock"
};

describe("guided workflow", () => {
  it("allows calculation without a GeoPDF after required geometry and assumptions are ready", () => {
    const workflow = workflowModel({
      ...baseState,
      skids: [[0, 0]],
      skid: [0, 0],
      skylines: [{ id: "1", coordinates: [[0, 0], [1, 1]] }],
      assumptionsTouched: true
    });

    expect(workflow.canCalculate).toBe(true);
    expect(workflow.primaryAction).toMatchObject({ action: "calculate", enabled: true });
  });

  it("keeps GeoPDF as an optional first workflow step", () => {
    const workflow = workflowModel(baseState);

    expect(workflow.steps[0]).toMatchObject({
      label: "Add GeoPDF",
      optional: true,
      enabled: true,
      action: "import-geopdf"
    });
    expect(workflow.steps[1]).toMatchObject({ action: "draw-skid", enabled: true, current: true });
  });
});