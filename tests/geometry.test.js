import { describe, expect, it } from "vitest";
import { formatArea, polygonAreaSquareMetres } from "../src/geometry.js";

describe("geometry helpers", () => {
  it("calculates approximate polygon area in square metres", () => {
    const polygon = [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]];

    expect(polygonAreaSquareMetres(polygon)).toBeGreaterThan(12000);
    expect(polygonAreaSquareMetres(polygon)).toBeLessThan(13000);
  });

  it("formats harvest setting area for display", () => {
    expect(formatArea(12500)).toBe("1.25 ha");
    expect(formatArea(125000)).toBe("12.5 ha");
    expect(formatArea(9000)).toBe("9000 m2");
  });
});
