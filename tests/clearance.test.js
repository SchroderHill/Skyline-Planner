import { describe, expect, it } from "vitest";
import { calculateSkyline } from "../src/clearance.js";

function terrain(elevations) {
  return {
    async sampleLine() {
      return elevations;
    }
  };
}

const assumptions = {
  landingTowerHeight: 20,
  tailholdHeight: 20,
  minimumClearance: 5,
  manualSagAllowance: 0,
  deflectionPercent: 0,
  sampleSpacing: 50
};

const skyline = { id: "skyline-1", coordinates: [[0, 0], [0.001, 0]] };

describe("clearance calculation", () => {
  it("returns green/pass when cable stays above minimum clearance", async () => {
    const result = await calculateSkyline(skyline, assumptions, terrain([100, 100, 100]));

    expect(result.pass).toBe(true);
    expect(result.percentGreen).toBe(100);
    expect(result.samples.every((sample) => sample.status === "green")).toBe(true);
  });

  it("returns red/fail when cable intersects ground", async () => {
    const result = await calculateSkyline(skyline, assumptions, terrain([100, 125, 100]));

    expect(result.pass).toBe(false);
    expect(result.percentRed).toBeGreaterThan(0);
    expect(result.minClearance).toBeLessThanOrEqual(0);
  });

  it("manual sag allowance reduces clearance", async () => {
    const withoutSag = await calculateSkyline(skyline, assumptions, terrain([100, 100, 100]));
    const withSag = await calculateSkyline(
      skyline,
      { ...assumptions, manualSagAllowance: 8 },
      terrain([100, 100, 100])
    );

    expect(withSag.minClearance).toBe(withoutSag.minClearance - 8);
  });

  it("calculates green/red percentages across multiple samples", async () => {
    const result = await calculateSkyline(skyline, assumptions, terrain([100, 116, 100]));

    expect(result.samples).toHaveLength(3);
    expect(result.percentGreen).toBeCloseTo(66.666, 2);
    expect(result.percentRed).toBeCloseTo(33.333, 2);
  });

  it("0% deflection equals the straight chord model", async () => {
    const result = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 0 }, terrain([100, 100, 100]));

    result.samples.forEach((sample) => {
      expect(sample.skylineElevation).toBeCloseTo(sample.chordElevation, 6);
      expect(sample.sagAtPoint).toBeCloseTo(0, 6);
    });
  });

  it("6% deflection lowers the skyline at midspan", async () => {
    const result = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 6 }, terrain([100, 100, 100]));
    const mid = result.samples[1];

    expect(mid.skylineElevation).toBeLessThan(mid.chordElevation);
    expect(mid.sagAtPoint).toBeCloseTo(result.length * 0.06, 1);
  });

  it("sag is zero at the landing and tailhold", async () => {
    const result = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 8 }, terrain([100, 100, 100]));

    expect(result.samples[0].sagAtPoint).toBeCloseTo(0, 6);
    expect(result.samples.at(-1).sagAtPoint).toBeCloseTo(0, 6);
  });

  it("maximum sag occurs at midspan", async () => {
    const result = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 10 }, terrain([100, 100, 100]));
    const sagValues = result.samples.map((sample) => sample.sagAtPoint);

    expect(Math.max(...sagValues)).toBe(result.samples[1].sagAtPoint);
  });

  it("higher deflection creates lower skyline elevation", async () => {
    const low = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 2 }, terrain([100, 100, 100]));
    const high = await calculateSkyline(skyline, { ...assumptions, deflectionPercent: 10 }, terrain([100, 100, 100]));

    expect(high.samples[1].skylineElevation).toBeLessThan(low.samples[1].skylineElevation);
  });

  it("clearance classification uses the deflected skyline, not the chord", async () => {
    const result = await calculateSkyline(
      skyline,
      { ...assumptions, minimumClearance: 5, deflectionPercent: 10 },
      terrain([100, 111, 100])
    );

    expect(result.samples[1].chordElevation - result.samples[1].groundElevation).toBeGreaterThanOrEqual(5);
    expect(result.samples[1].clearance).toBeLessThan(5);
    expect(result.samples[1].status).toBe("red");
  });
});
