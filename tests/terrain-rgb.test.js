import { describe, expect, it } from "vitest";
import {
  MapboxTerrainRgbProvider,
  decodeTerrainRgb,
  fetchTerrainRgbTile,
  lngLatToGlobalPixel,
  terrainRgbTileUrl
} from "../src/terrain-rgb.js";

describe("Mapbox Terrain-RGB provider", () => {
  it("decodes Mapbox RGB elevation values", () => {
    expect(decodeTerrainRgb(1, 150, 136)).toBeCloseTo(407.2, 6);
  });

  it("builds a fixed-resolution pngraw tile URL", () => {
    const url = terrainRgbTileUrl({
      accessToken: "pk.test/value",
      zoom: 14,
      x: 100,
      y: 200,
      tileSize: 512
    });

    expect(url).toContain("/mapbox.terrain-rgb/14/100/200@2x.pngraw");
    expect(url).toContain("access_token=pk.test%2Fvalue");
  });

  it("maps longitude and latitude into deterministic global pixels", () => {
    expect(lngLatToGlobalPixel([0, 0], 0, 256)).toMatchObject({ x: 128, y: 128, worldSize: 256 });
  });

  it("bilinearly interpolates the four surrounding terrain pixels", async () => {
    const provider = new MapboxTerrainRgbProvider({
      accessToken: "test-token",
      zoom: 0,
      tileSize: 4,
      tileLoader: async () => elevationTile(4, 4, (x, y) => y * 10 + x)
    });

    const [elevation] = await provider.sampleLine([[0, 0]]);

    expect(elevation).toBeCloseTo(16.5, 6);
  });

  it("reuses decoded tiles across calculations", async () => {
    let loads = 0;
    const provider = new MapboxTerrainRgbProvider({
      accessToken: "test-token",
      zoom: 0,
      tileSize: 4,
      tileLoader: async () => {
        loads += 1;
        return { width: 4, height: 4, constantElevation: 321.5 };
      }
    });

    await provider.sampleLine([[0, 0], [1, 1]]);
    await provider.sampleLine([[0, 0]]);

    expect(loads).toBe(1);
  });

  it("removes failed requests from the cache so Retry can recover", async () => {
    let loads = 0;
    const provider = new MapboxTerrainRgbProvider({
      accessToken: "test-token",
      zoom: 0,
      tileSize: 4,
      tileLoader: async () => {
        loads += 1;
        if (loads === 1) throw new Error("temporary network failure");
        return { width: 4, height: 4, constantElevation: 88 };
      }
    });

    await expect(provider.sampleLine([[0, 0]])).rejects.toThrow("temporary network failure");
    await expect(provider.sampleLine([[0, 0]])).resolves.toEqual([88]);
    expect(loads).toBe(2);
  });

  it("treats Mapbox's missing all-ocean tiles as zero elevation", async () => {
    const tile = await fetchTerrainRgbTile({
      url: "https://example.test/ocean.pngraw",
      tileSize: 4,
      retryDelaysMs: [],
      fetchImpl: async () => new Response(
        JSON.stringify({ message: "Tile does not exist" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    });

    expect(tile.constantElevation).toBe(0);
  });
});

function elevationTile(width, height, elevationAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const encoded = Math.round((elevationAt(x, y) + 10000) * 10);
      const offset = (y * width + x) * 4;
      data[offset] = Math.floor(encoded / (256 * 256));
      data[offset + 1] = Math.floor(encoded / 256) % 256;
      data[offset + 2] = encoded % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}
