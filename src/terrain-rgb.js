const MAX_MERCATOR_LATITUDE = 85.0511287798066;
const DEFAULT_ZOOM = 14;
const DEFAULT_TILE_SIZE = 512;
const DEFAULT_MAX_CACHED_TILES = 24;
const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_RETRY_DELAYS_MS = [350, 900];

export class TerrainRgbError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "TerrainRgbError";
  }
}

export function decodeTerrainRgb(red, green, blue) {
  return -10000 + ((red * 256 * 256 + green * 256 + blue) * 0.1);
}

export function terrainRgbTileUrl({ accessToken, zoom, x, y, tileSize = DEFAULT_TILE_SIZE }) {
  const scale = tileSize === 512 ? "@2x" : "";
  return `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}${scale}.pngraw`
    + `?access_token=${encodeURIComponent(accessToken)}`;
}

export function lngLatToGlobalPixel(coordinate, zoom, tileSize = DEFAULT_TILE_SIZE) {
  const [longitude, latitude] = coordinate ?? [];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new TerrainRgbError("Terrain coordinates must contain valid longitude and latitude values.");
  }

  const tilesAtZoom = 2 ** zoom;
  const worldSize = tilesAtZoom * tileSize;
  const wrappedLongitude = modulo(longitude + 180, 360);
  const clampedLatitude = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const latitudeRadians = clampedLatitude * Math.PI / 180;
  const sinLatitude = Math.sin(latitudeRadians);

  return {
    x: (wrappedLongitude / 360) * worldSize,
    y: clamp(
      (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * worldSize,
      0,
      worldSize - Number.EPSILON
    ),
    worldSize
  };
}

export class MapboxTerrainRgbProvider {
  constructor({
    accessToken,
    zoom = DEFAULT_ZOOM,
    tileSize = DEFAULT_TILE_SIZE,
    maxCachedTiles = DEFAULT_MAX_CACHED_TILES,
    tileLoader
  } = {}) {
    if (!accessToken && !tileLoader) {
      throw new TerrainRgbError("A Mapbox access token is required for terrain sampling.");
    }
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 30) {
      throw new TerrainRgbError("Terrain zoom must be an integer between 0 and 30.");
    }
    if (!Number.isInteger(tileSize) || tileSize < 2) {
      throw new TerrainRgbError("Terrain tile size must be at least 2 pixels.");
    }

    this.label = "Mapbox Terrain-RGB";
    this.mode = "mapbox";
    this.accessToken = accessToken ?? "";
    this.zoom = zoom;
    this.tileSize = tileSize;
    this.maxCachedTiles = Math.max(1, Number(maxCachedTiles) || DEFAULT_MAX_CACHED_TILES);
    this.tileLoader = tileLoader ?? ((tile) => fetchTerrainRgbTile(tile));
    this.tileCache = new Map();
  }

  async sampleLine(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return [];

    const samples = coordinates.map((coordinate) =>
      interpolationSample(coordinate, this.zoom, this.tileSize)
    );
    const tileRequests = new Map();

    samples.forEach((sample) => {
      sample.pixels.forEach((pixel) => {
        const key = tileKey(this.zoom, pixel.tileX, pixel.tileY);
        if (!tileRequests.has(key)) {
          tileRequests.set(key, this.getTile(pixel.tileX, pixel.tileY));
        }
      });
    });

    let tiles;
    try {
      tiles = new Map(await Promise.all(
        [...tileRequests.entries()].map(async ([key, promise]) => [key, await promise])
      ));
    } catch (error) {
      if (error instanceof TerrainRgbError) throw error;
      throw new TerrainRgbError(
        `Mapbox terrain data could not be loaded. ${error?.message || "Check the connection and retry."}`,
        { cause: error }
      );
    }

    return samples.map((sample) => sample.pixels.reduce((elevation, pixel) => {
      const tile = tiles.get(tileKey(this.zoom, pixel.tileX, pixel.tileY));
      return elevation + readElevation(tile, pixel.pixelX, pixel.pixelY) * pixel.weight;
    }, 0));
  }

  clearCache() {
    this.tileCache.clear();
  }

  getTile(x, y) {
    const key = tileKey(this.zoom, x, y);
    if (this.tileCache.has(key)) {
      const cached = this.tileCache.get(key);
      this.tileCache.delete(key);
      this.tileCache.set(key, cached);
      return cached;
    }

    const request = Promise.resolve().then(() => this.tileLoader({
      accessToken: this.accessToken,
      zoom: this.zoom,
      x,
      y,
      tileSize: this.tileSize,
      url: terrainRgbTileUrl({
        accessToken: this.accessToken,
        zoom: this.zoom,
        x,
        y,
        tileSize: this.tileSize
      })
    })).then((tile) => validateTile(tile, this.tileSize)).catch((error) => {
      if (this.tileCache.get(key) === request) this.tileCache.delete(key);
      throw error;
    });

    this.tileCache.set(key, request);
    while (this.tileCache.size > this.maxCachedTiles) {
      this.tileCache.delete(this.tileCache.keys().next().value);
    }
    return request;
  }
}

export async function fetchTerrainRgbTile({
  url,
  tileSize = DEFAULT_TILE_SIZE,
  fetchImpl = globalThis.fetch,
  decodeImage = decodeImageBlob,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS
}) {
  if (typeof fetchImpl !== "function") {
    throw new TerrainRgbError("This browser cannot request Mapbox terrain tiles.");
  }

  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: "force-cache",
        mode: "cors",
        signal: controller.signal
      });

      if (response.status === 404) {
        const message = await responseMessage(response);
        if (/tile does not exist/i.test(message)) {
          return { width: tileSize, height: tileSize, constantElevation: 0 };
        }
      }

      if (!response.ok) {
        const error = terrainHttpError(response.status);
        if (!isRetryableStatus(response.status) || attempt === retryDelaysMs.length) throw error;
        lastError = error;
      } else {
        const tile = await decodeImage(await response.blob());
        return validateTile(tile, tileSize);
      }
    } catch (error) {
      if (error instanceof TerrainRgbError && !isRetryableStatus(error.status)) throw error;
      lastError = error?.name === "AbortError"
        ? new TerrainRgbError("Mapbox terrain took too long to respond. Retry the calculation.", { cause: error })
        : error;
      if (attempt === retryDelaysMs.length) break;
    } finally {
      clearTimeout(timeout);
    }

    await delay(retryDelaysMs[attempt]);
  }

  if (lastError instanceof TerrainRgbError) throw lastError;
  throw new TerrainRgbError("Mapbox terrain could not be reached. Check the connection and retry.", {
    cause: lastError
  });
}

function interpolationSample(coordinate, zoom, tileSize) {
  const { x, y, worldSize } = lngLatToGlobalPixel(coordinate, zoom, tileSize);
  // Terrain values describe pixel centres, so shift by half a pixel before interpolation.
  const sampleX = x - 0.5;
  const sampleY = y - 0.5;
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const xFraction = sampleX - x0;
  const yFraction = sampleY - y0;

  return {
    pixels: [
      weightedPixel(x0, y0, (1 - xFraction) * (1 - yFraction), worldSize, tileSize),
      weightedPixel(x0 + 1, y0, xFraction * (1 - yFraction), worldSize, tileSize),
      weightedPixel(x0, y0 + 1, (1 - xFraction) * yFraction, worldSize, tileSize),
      weightedPixel(x0 + 1, y0 + 1, xFraction * yFraction, worldSize, tileSize)
    ].filter((pixel) => pixel.weight > 0)
  };
}

function weightedPixel(globalX, globalY, weight, worldSize, tileSize) {
  const x = modulo(globalX, worldSize);
  const y = clamp(globalY, 0, worldSize - 1);
  return {
    tileX: Math.floor(x / tileSize),
    tileY: Math.floor(y / tileSize),
    pixelX: x % tileSize,
    pixelY: y % tileSize,
    weight
  };
}

function readElevation(tile, x, y) {
  if (Number.isFinite(tile.constantElevation)) return tile.constantElevation;
  const offset = (y * tile.width + x) * 4;
  return decodeTerrainRgb(tile.data[offset], tile.data[offset + 1], tile.data[offset + 2]);
}

function validateTile(tile, tileSize) {
  if (Number.isFinite(tile?.constantElevation)) return tile;
  if (tile?.width !== tileSize || tile?.height !== tileSize || !tile?.data) {
    throw new TerrainRgbError("Mapbox returned an invalid terrain tile. Retry the calculation.");
  }
  return tile;
}

async function decodeImageBlob(blob) {
  const image = await imageFromBlob(blob);
  const width = image.width;
  const height = image.height;
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    closeImage(image);
    throw new TerrainRgbError("This browser could not decode Mapbox terrain data.");
  }
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  closeImage(image);
  return { width, height, data };
}

async function imageFromBlob(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none"
      });
    } catch {
      return createImageBitmap(blob);
    }
  }
  if (typeof Image !== "function") {
    throw new TerrainRgbError("This browser cannot decode Mapbox terrain images.");
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function closeImage(image) {
  if (typeof image?.close === "function") image.close();
}

async function responseMessage(response) {
  try {
    const body = await response.clone().json();
    return String(body?.message ?? "");
  } catch {
    return "";
  }
}

function terrainHttpError(status) {
  let message = `Mapbox terrain request failed (HTTP ${status}). Retry the calculation.`;
  if (status === 401 || status === 403) {
    message = "Mapbox rejected the terrain request. Check the access token and its URL restrictions.";
  } else if (status === 429) {
    message = "Mapbox terrain is temporarily rate-limited. Wait a moment and retry.";
  }
  const error = new TerrainRgbError(message);
  error.status = status;
  return error;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function tileKey(zoom, x, y) {
  return `${zoom}/${x}/${y}`;
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
