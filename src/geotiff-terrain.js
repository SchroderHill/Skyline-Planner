/**
 * GeoTIFF DEM terrain provider.
 *
 * Supports:
 *   EPSG:4326  – WGS84 geographic (lon/lat). Sample points used as-is.
 *   EPSG:2193  – NZTM2000 (NZ Transverse Mercator). Sample points (lon/lat)
 *                are reprojected to easting/northing before sampling.
 *
 * The raster is never reprojected – only the query points are converted.
 */

import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";

// ── CRS definitions ─────────────────────────────────────────────────────────

const NZTM_DEF =
  "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 " +
  "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

const WGS84_DEF = "+proj=longlat +datum=WGS84 +no_defs";

// Map EPSG code → proj4 definition + human label
const SUPPORTED_CRS = {
  4326: { def: WGS84_DEF, label: "EPSG:4326 / WGS84", geographic: true },
  2193: { def: NZTM_DEF, label: "EPSG:2193 / NZTM2000", geographic: false },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract EPSG code (integer) from a GeoTIFF's GeoKeys, or null if unknown. */
function extractEpsg(geoKeys) {
  // ProjectedCSTypeGeoKey = 3072, GeographicTypeGeoKey = 2048
  return geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey ?? null;
}

/**
 * Parse the ModelPixelScaleTag / ModelTiepointTag from an image to build
 * a simple affine transform: pixel (col, row) → CRS coordinate.
 * Returns { originX, originY, pixelWidth, pixelHeight, width, height }.
 */
function buildTransform(image) {
  const [sx, sy] = image.getResolution();         // [xRes, yRes, zRes] — yRes is negative
  const [ox, oy] = image.getOrigin();             // [x, y, z] — top-left corner in CRS units
  const width = image.getWidth();
  const height = image.getHeight();
  return {
    originX: ox,
    originY: oy,
    pixelWidth: Math.abs(sx),
    pixelHeight: Math.abs(sy),
    width,
    height,
  };
}

/** Convert a CRS coordinate to fractional pixel position (col, row). */
function crsToPixel(x, y, t) {
  const col = (x - t.originX) / t.pixelWidth;
  const row = (t.originY - y) / t.pixelHeight;
  return { col, row };
}

/** Bilinear sample of a flat Float32/Float64 raster array. */
function bilinearSample(data, col, row, width, height, nodata) {
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = c0 + 1;
  const r1 = r0 + 1;

  if (c0 < 0 || r0 < 0 || c1 >= width || r1 >= height) return null;

  const get = (c, r) => {
    const v = data[r * width + c];
    return (nodata !== undefined && Math.abs(v - nodata) < 1e-4) ? null : v;
  };

  const q00 = get(c0, r0);
  const q10 = get(c1, r0);
  const q01 = get(c0, r1);
  const q11 = get(c1, r1);

  if (q00 === null || q10 === null || q01 === null || q11 === null) return null;

  const dc = col - c0;
  const dr = row - r0;
  return q00 * (1 - dc) * (1 - dr)
       + q10 * dc * (1 - dr)
       + q01 * (1 - dc) * dr
       + q11 * dc * dr;
}

// ── Main class ───────────────────────────────────────────────────────────────

export class GeoTiffTerrainProvider {
  constructor() {
    this.label = "Uploaded GeoTIFF DEM";
    this.mode = "geotiff";
    this._ready = false;
    this.meta = null;   // { epsg, crsLabel, bounds, width, height, resolutionM }
    this._data = null;
    this._transform = null;
    this._nodata = undefined;
    this._toProjected = null; // proj4 forward function (lon/lat → CRS)
    this._epsg = null;
  }

  /** Reset provider to its initial (unloaded) state. */
  reset() {
    this._ready = false;
    this.meta = null;
    this._data = null;
    this._transform = null;
    this._nodata = undefined;
    this._toProjected = null;
    this._epsg = null;
  }

  /** Load a File object. Resolves with metadata, rejects with Error on failure. */
  async loadFile(file) {
    const buffer = await file.arrayBuffer();
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    const geoKeys = image.getGeoKeys();
    const epsg = extractEpsg(geoKeys);

    const crsInfo = SUPPORTED_CRS[epsg];
    if (!crsInfo) {
      const msg = epsg
        ? `Unsupported CRS: EPSG:${epsg}. Only EPSG:4326 and EPSG:2193 are supported.`
        : "Could not read CRS from GeoTIFF. Only EPSG:4326 and EPSG:2193 are supported.";
      throw new Error(msg);
    }

    const transform = buildTransform(image);

    // Raster data — read first band as Float64
    const rasters = await image.readRasters({ interleave: false });
    const rawData = rasters[0];
    const data = Float64Array.from(rawData);

    // nodata value
    let nodata;
    try {
      nodata = image.getGDALNoData();
    } catch {
      nodata = undefined;
    }

    // Build coordinate bounds in CRS units
    const { originX, originY, pixelWidth, pixelHeight, width, height } = transform;
    const minX = originX;
    const maxY = originY;
    const maxX = originX + width * pixelWidth;
    const minY = originY - height * pixelHeight;

    // Approx ground resolution in metres
    let resolutionM = pixelWidth;
    if (crsInfo.geographic) {
      // degrees → rough metres at mid-latitude
      const midLat = (minY + maxY) / 2;
      resolutionM = pixelWidth * Math.cos((midLat * Math.PI) / 180) * 111320;
    }

    // proj4 converter: WGS84 lon/lat → DEM CRS
    if (!crsInfo.geographic) {
      proj4.defs("EPSG:2193", NZTM_DEF);
      this._toProjected = proj4(WGS84_DEF, crsInfo.def).forward;
    } else {
      this._toProjected = ([lon, lat]) => [lon, lat];
    }

    // WGS84 bounding box for map display
    let boundsLngLat;
    if (crsInfo.geographic) {
      boundsLngLat = { west: minX, south: minY, east: maxX, north: maxY };
    } else {
      const toWgs84 = proj4(crsInfo.def, WGS84_DEF).forward;
      const sw = toWgs84([minX, minY]);
      const ne = toWgs84([maxX, maxY]);
      boundsLngLat = { west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
    }

    this._data = data;
    this._transform = transform;
    this._nodata = nodata;
    this._epsg = epsg;
    this._ready = true;

    this.meta = {
      epsg,
      crsLabel: crsInfo.label,
      bounds: { minX, minY, maxX, maxY },
      boundsLngLat,
      width,
      height,
      resolutionM: Math.round(resolutionM * 10) / 10,
      filename: file.name,
    };

    return this.meta;
  }

  /** Sample elevations for an array of [lon, lat] coordinates (WGS84). */
  async sampleLine(coordinates) {
    if (!this._ready) throw new Error("No GeoTIFF loaded.");

    const t = this._transform;
    const elevations = [];
    const outOfBounds = [];

    for (let i = 0; i < coordinates.length; i++) {
      const [lon, lat] = coordinates[i];
      const [cx, cy] = this._toProjected([lon, lat]);
      const { col, row } = crsToPixel(cx, cy, t);

      if (col < 0 || row < 0 || col >= t.width || row >= t.height) {
        outOfBounds.push(i);
        elevations.push(NaN);
        continue;
      }

      const elev = bilinearSample(this._data, col, row, t.width, t.height, this._nodata);
      elevations.push(elev !== null ? elev : NaN);
    }

    if (outOfBounds.length > 0) {
      const pct = ((outOfBounds.length / coordinates.length) * 100).toFixed(0);
      throw new Error(
        `${outOfBounds.length} of ${coordinates.length} sample points (${pct}%) fall outside the uploaded DEM extent. ` +
        "Upload a DEM that covers the full skyline, or use Mapbox terrain."
      );
    }

    if (elevations.some((e) => !Number.isFinite(e))) {
      throw new Error("Some sample points coincide with no-data cells in the uploaded DEM.");
    }

    return elevations;
  }
}
