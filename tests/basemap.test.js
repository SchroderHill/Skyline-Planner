import { describe, expect, it } from "vitest";
import {
  baseMapLayerOpacity,
  baseMapStyleFor,
  DEFAULT_BASE_MAP_MODE,
  normalizeBaseMapMode
} from "../src/basemap.js";

describe("basemap defaults", () => {
  it("falls back to Google satellite for missing or invalid modes", () => {
    expect(DEFAULT_BASE_MAP_MODE).toBe("google-satellite");
    expect(normalizeBaseMapMode()).toBe("google-satellite");
    expect(normalizeBaseMapMode("not-a-map")).toBe("google-satellite");
  });

  it("distinguishes imagery visibility even when styles are shared", () => {
    expect(baseMapStyleFor("google-satellite")).toBe(baseMapStyleFor("sentinel-2"));
    expect(baseMapLayerOpacity("google-satellite", "google-satellite")).toBe(1);
    expect(baseMapLayerOpacity("google-satellite", "sentinel-2")).toBe(0);
    expect(baseMapLayerOpacity("sentinel-2", "google-satellite")).toBe(0);
    expect(baseMapLayerOpacity("sentinel-2", "sentinel-2")).toBe(1);
  });
});
