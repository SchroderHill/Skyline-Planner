import { describe, expect, it } from "vitest";
import { reanchorSkylinesToMovedSkids } from "../src/skid-anchor.js";

const line = (id, coordinates) => ({
  id,
  type: "Feature",
  properties: { role: "skyline", skylineId: id },
  geometry: { type: "LineString", coordinates }
});

const movedSkid = (skidId, coordinates) => ({
  id: `skid-${skidId}`,
  type: "Feature",
  properties: { role: "skid", skidId: String(skidId) },
  geometry: { type: "Point", coordinates }
});

const plainPoint = (id, coordinates) => ({
  id,
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates }
});

describe("skid anchor reanchoring", () => {
  it("moves skyline endpoints attached to the moved skid", () => {
    const features = [line("1", [[0, 0], [1, 1], [2, 2]])];

    const result = reanchorSkylinesToMovedSkids(
      features,
      { skids: [[0, 0]] },
      [movedSkid(1, [0.5, 0.5])]
    );

    expect(result.changed).toBe(true);
    expect(result.features[0].geometry.coordinates).toEqual([[0.5, 0.5], [1, 1], [2, 2]]);
  });

  it("does not move unattached skyline endpoints", () => {
    const features = [line("1", [[9, 9], [1, 1], [2, 2]])];

    const result = reanchorSkylinesToMovedSkids(
      features,
      { skids: [[0, 0]] },
      [movedSkid(1, [0.5, 0.5])]
    );

    expect(result.changed).toBe(false);
    expect(result.features[0]).toBe(features[0]);
  });

  it("only moves corridors attached to the moved skid when multiple skids exist", () => {
    const features = [
      line("1", [[0, 0], [1, 1]]),
      line("2", [[5, 5], [6, 6]])
    ];

    const result = reanchorSkylinesToMovedSkids(
      features,
      { skids: [[0, 0], [5, 5]] },
      [movedSkid(2, [7, 7])]
    );

    expect(result.changed).toBe(true);
    expect(result.features[0].geometry.coordinates).toEqual([[0, 0], [1, 1]]);
    expect(result.features[1].geometry.coordinates).toEqual([[7, 7], [6, 6]]);
  });

  it("preserves intermediate vertices and moves a tail endpoint", () => {
    const features = [line("1", [[2, 2], [1, 1], [0, 0]])];

    const result = reanchorSkylinesToMovedSkids(
      features,
      { skids: [[0, 0]] },
      [movedSkid(1, [0.5, 0.5])]
    );

    expect(result.features[0].geometry.coordinates).toEqual([[2, 2], [1, 1], [0.5, 0.5]]);
  });

  it("does nothing when the moved skid id is missing or invalid", () => {
    const features = [line("1", [[0, 0], [1, 1]])];
    const invalidSkid = movedSkid(1, [0.5, 0.5]);
    delete invalidSkid.properties.skidId;

    const result = reanchorSkylinesToMovedSkids(features, { skids: [[0, 0]] }, [invalidSkid]);

    expect(result.changed).toBe(false);
    expect(result.features).toBe(features);
  });

  it("moves corridors attached to a later added plain Draw skid point by point order", () => {
    const secondSkid = plainPoint("draw-skid-b", [7, 7]);
    const features = [
      plainPoint("draw-skid-a", [0, 0]),
      secondSkid,
      line("1", [[0, 0], [1, 1]]),
      line("2", [[5, 5], [6, 6]])
    ];

    const movedSecondSkid = { ...secondSkid, geometry: { ...secondSkid.geometry, coordinates: [7, 7] } };
    const result = reanchorSkylinesToMovedSkids(
      features,
      { skids: [[0, 0], [5, 5]] },
      [movedSecondSkid]
    );

    expect(result.changed).toBe(true);
    expect(result.features[2].geometry.coordinates).toEqual([[0, 0], [1, 1]]);
    expect(result.features[3].geometry.coordinates).toEqual([[7, 7], [6, 6]]);
  });
});