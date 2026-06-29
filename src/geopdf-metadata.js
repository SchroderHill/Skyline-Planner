import proj4 from "proj4";

const WGS84_DEF = "+proj=longlat +datum=WGS84 +no_defs";
const WEB_MERCATOR_DEF = "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs";
const NZTM_DEF =
  "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 " +
  "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";
const NZGD1949_DEF =
  "+proj=nzmg +lat_0=-41 +lon_0=173 +x_0=2510000 +y_0=6023150 +ellps=intl +datum=nzgd49 +units=m +no_defs";

const KNOWN_EPSG_DEFS = {
  4326: WGS84_DEF,
  3857: WEB_MERCATOR_DEF,
  2193: NZTM_DEF,
  27200: NZGD1949_DEF,
};

export async function extractGeoPdfGeoreference(buffer) {
  registerKnownCrsDefinitions();
  const pdfLib = await import("pdf-lib");
  let pdfDocument;
  try {
    pdfDocument = await pdfLib.PDFDocument.load(new Uint8Array(buffer), {
      updateMetadata: false,
    });
  } catch (error) {
    throw new Error(`The PDF metadata could not be read: ${error.message}`);
  }

  if (pdfDocument.getPageCount() < 1) {
    throw new Error("The PDF has no pages to import.");
  }

  const page = pdfDocument.getPage(0);
  const extraction = extractStructuredCandidates(page, pdfDocument.context, pdfLib);
  const validCandidates = [];
  const validationErrors = [...extraction.errors];

  for (const candidate of extraction.candidates) {
    try {
      validCandidates.push(await buildGeoreference(candidate));
    } catch (error) {
      validationErrors.push(error.message);
    }
  }

  if (!validCandidates.length) {
    if (!extraction.metadataFound) {
      throw new Error("No supported geospatial metadata was found on page 1.");
    }
    const detail = validationErrors.find(Boolean) ?? "No valid geospatial viewport could be derived.";
    throw new Error(`Geospatial metadata was found, but it is invalid: ${detail}`);
  }

  return selectPrimaryCandidate(validCandidates);
}

function registerKnownCrsDefinitions() {
  proj4.defs("EPSG:4326", WGS84_DEF);
  Object.entries(KNOWN_EPSG_DEFS).forEach(([epsg, definition]) => {
    proj4.defs(`EPSG:${epsg}`, definition);
  });
}

function extractStructuredCandidates(page, context, pdfLib) {
  const result = {
    candidates: [],
    errors: [],
    metadataFound: false,
  };

  extractOgcCandidates(page, context, pdfLib, result);
  extractLgiCandidates(page, context, pdfLib, result);
  return result;
}

function extractOgcCandidates(page, context, pdfLib, result) {
  const { PDFArray, PDFDict, PDFName } = pdfLib;
  const viewportObject = resolveObject(page.node.get(PDFName.of("VP")), context);
  const viewports = [];

  if (viewportObject instanceof PDFArray) {
    for (let index = 0; index < viewportObject.size(); index += 1) {
      const viewport = resolveObject(viewportObject.get(index), context);
      if (viewport instanceof PDFDict) viewports.push(viewport);
    }
  } else if (viewportObject instanceof PDFDict) {
    viewports.push(viewportObject);
  }

  for (const viewport of viewports) {
    const measure = safeLookup(viewport, "Measure", pdfLib.PDFDict, pdfLib);
    if (!measure) continue;
    result.metadataFound = true;
    try {
      const bbox = readRectangle(viewport, "BBox", pdfLib);
      const gpts = readNumberArray(measure, "GPTS", pdfLib);
      const lpts = readNumberArray(measure, "LPTS", pdfLib);
      if (!bbox) throw new Error("A geospatial viewport has no valid BBox.");
      validateControlArrays(gpts, lpts);

      const gcs = safeLookup(measure, "GCS", pdfLib.PDFDict, pdfLib);
      const declaredEpsg = readEpsg(gcs, pdfLib);
      result.candidates.push({
        kind: "ogc",
        bbox,
        gpts,
        lpts,
        declaredEpsg,
        coordinateMode: "geographic",
      });
    } catch (error) {
      result.errors.push(error.message);
    }
  }
}

function extractLgiCandidates(page, context, pdfLib, result) {
  const { PDFArray, PDFDict, PDFName } = pdfLib;
  const dictionaries = [];
  const seen = new Set();
  const addDictionary = (dictionary) => {
    if (!(dictionary instanceof PDFDict) || seen.has(dictionary)) return;
    seen.add(dictionary);
    dictionaries.push(dictionary);
  };

  const pageLgiObject = resolveObject(page.node.get(PDFName.of("LGIDict")), context);
  if (pageLgiObject instanceof PDFArray) {
    for (let index = 0; index < pageLgiObject.size(); index += 1) {
      addDictionary(resolveObject(pageLgiObject.get(index), context));
    }
  } else {
    addDictionary(pageLgiObject);
  }

  if (!dictionaries.length) {
    for (const [, object] of context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      if (object.has(PDFName.of("CTM")) && object.has(PDFName.of("Neatline"))) {
        addDictionary(object);
      }
    }
  }

  for (const dictionary of dictionaries) {
    result.metadataFound = true;
    try {
      const ctm = readNumberArray(dictionary, "CTM", pdfLib);
      const neatline = readNumberArray(dictionary, "Neatline", pdfLib);
      if (ctm.length !== 6) throw new Error("An LGIDict CTM must contain six numbers.");
      if (neatline.length < 8 || neatline.length % 2 !== 0) {
        throw new Error("An LGIDict neatline must contain at least four coordinate pairs.");
      }

      const pagePoints = toPairs(neatline);
      const bbox = boundsOfPoints(pagePoints);
      if (!bbox) throw new Error("An LGIDict neatline has invalid bounds.");
      const declaredEpsg = readCandidateEpsg(dictionary, pdfLib);
      if (!declaredEpsg) {
        throw new Error("Projected GeoPDF metadata has no usable CRS.");
      }

      const [a, b, c, d, e, f] = ctm;
      const projectedPoints = pagePoints.map(([x, y]) => [
        a * x + c * y + e,
        b * x + d * y + f,
      ]);

      result.candidates.push({
        kind: "lgi",
        bbox,
        gpts: projectedPoints.flat(),
        lpts: pagePoints.flat(),
        declaredEpsg,
        coordinateMode: "projected",
      });
    } catch (error) {
      result.errors.push(error.message);
    }
  }
}

function readCandidateEpsg(dictionary, pdfLib) {
  const direct = readEpsg(dictionary, pdfLib);
  if (direct) return direct;
  for (const key of ["Projection", "GCS", "CoordinateSystem"]) {
    const nested = safeLookup(dictionary, key, pdfLib.PDFDict, pdfLib);
    const epsg = readEpsg(nested, pdfLib);
    if (epsg) return epsg;
  }
  return null;
}

function readEpsg(dictionary, pdfLib) {
  if (!dictionary) return null;
  const epsgNumber = safeLookup(dictionary, "EPSG", pdfLib.PDFNumber, pdfLib);
  if (epsgNumber) {
    const value = epsgNumber.asNumber();
    if (Number.isInteger(value) && value > 0) return value;
  }

  for (const key of ["EPSG", "WKT", "WKT2"]) {
    const value = readTextValue(dictionary, key, pdfLib);
    const epsg = extractEpsgFromText(value);
    if (epsg) return epsg;
  }
  return null;
}

function extractEpsgFromText(value) {
  if (!value) return null;
  const patterns = [
    /AUTHORITY\s*\[\s*["']EPSG["']\s*,\s*["']?(\d{4,6})/i,
    /ID\s*\[\s*["']EPSG["']\s*,\s*(\d{4,6})/i,
    /EPSG\D{0,12}(\d{4,6})/i,
    /^\s*(\d{4,6})\s*$/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function readTextValue(dictionary, key, pdfLib) {
  const { PDFHexString, PDFName, PDFString } = pdfLib;
  try {
    const value = dictionary.lookup(PDFName.of(key));
    if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) {
      return value.decodeText();
    }
  } catch {
    // Unsupported value type.
  }
  return "";
}

function readNumberArray(dictionary, key, pdfLib) {
  const array = safeLookup(dictionary, key, pdfLib.PDFArray, pdfLib);
  if (!array) return [];
  const values = [];
  for (let index = 0; index < array.size(); index += 1) {
    const number = array.lookupMaybe(index, pdfLib.PDFNumber);
    if (!number) throw new Error(`${key} contains a non-numeric value.`);
    values.push(number.asNumber());
  }
  return values;
}

function readRectangle(dictionary, key, pdfLib) {
  const values = readNumberArray(dictionary, key, pdfLib);
  if (values.length !== 4) return null;
  return normalizeBBox(values);
}

function safeLookup(dictionary, key, type, pdfLib) {
  if (!dictionary) return undefined;
  try {
    return dictionary.lookupMaybe(pdfLib.PDFName.of(key), type);
  } catch {
    return undefined;
  }
}

function resolveObject(object, context) {
  if (!object) return undefined;
  try {
    return context.lookup(object);
  } catch {
    return undefined;
  }
}

function validateControlArrays(gpts, lpts) {
  if (gpts.length < 8 || gpts.length % 2 !== 0) {
    throw new Error("GPTS must contain at least four coordinate pairs.");
  }
  if (lpts.length !== gpts.length) {
    throw new Error("GPTS and LPTS must contain the same number of values.");
  }
}

async function buildGeoreference(candidate) {
  const controlInputs = toPairs(candidate.lpts);
  const rawWorldPoints = toPairs(candidate.gpts);
  let controlWgs;

  if (candidate.coordinateMode === "geographic") {
    controlWgs = normalizeOgcGeographicPoints(rawWorldPoints);
  } else {
    if (!candidate.declaredEpsg) {
      throw new Error("Projected GeoPDF metadata has no usable CRS.");
    }
    const toWgs84 = await createToWgs84Transform(candidate.declaredEpsg);
    controlWgs = rawWorldPoints.map((point) => toWgs84(point));
  }

  validateControlSpread(controlWgs);
  const model = createAffineModel(controlInputs, controlWgs);
  const viewportArea = candidate.bbox.width * candidate.bbox.height;
  const projectPdfPoint = candidate.kind === "ogc"
    ? ([x, y]) => model.predict(
      (x - candidate.bbox.minX) / candidate.bbox.width,
      (y - candidate.bbox.minY) / candidate.bbox.height,
    )
    : ([x, y]) => model.predict(x, y);

  const viewportCoordinates = pdfBoxCorners(candidate.bbox).map(projectPdfPoint);
  viewportCoordinates.forEach((point) => {
    if (!validateLngLatPair(point)) {
      throw new Error("A geospatial viewport produces coordinates outside valid longitude/latitude ranges.");
    }
  });

  const boundsLngLat = boundsFromCorners(viewportCoordinates);
  if (!isValidBounds(boundsLngLat)) {
    throw new Error("A geospatial viewport produces invalid map bounds.");
  }

  const fitErrorMeters = calculateFitErrorMeters(model, controlInputs, controlWgs);
  const footprintDiagonalMeters = haversineMeters(
    [boundsLngLat.west, boundsLngLat.south],
    [boundsLngLat.east, boundsLngLat.north],
  );
  const rejectThresholdMeters = Math.max(100, footprintDiagonalMeters * 0.01);
  if (!Number.isFinite(fitErrorMeters) || fitErrorMeters > rejectThresholdMeters) {
    throw new Error("The geospatial control-point fit is too inaccurate to import safely.");
  }

  return {
    kind: candidate.kind,
    declaredEpsg: candidate.declaredEpsg ?? 4326,
    crsLabel: `EPSG:${candidate.declaredEpsg ?? 4326}`,
    viewportBBox: candidate.bbox,
    viewportArea,
    viewportCoordinates,
    boundsLngLat,
    fitErrorMeters,
    fitWarning: fitErrorMeters > Math.max(20, footprintDiagonalMeters * 0.0025),
    projectPdfPoint,
  };
}

function selectPrimaryCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const areaDifference = right.viewportArea - left.viewportArea;
    if (Math.abs(areaDifference) > 1e-6) return areaDifference;
    return left.fitErrorMeters - right.fitErrorMeters;
  })[0];
}

function normalizeOgcGeographicPoints(points) {
  const latLonValid = points.every(([lat, lng]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180);
  const lonLatValid = points.every(([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90);
  if (latLonValid) return points.map(([lat, lng]) => [lng, lat]);
  if (lonLatValid) return points.map(([lng, lat]) => [lng, lat]);
  throw new Error("GPTS does not contain valid geographic latitude/longitude values.");
}

async function createToWgs84Transform(epsg) {
  await ensureProjDefinition(epsg);
  const converter = proj4(`EPSG:${epsg}`, "EPSG:4326");
  return ([x, y]) => converter.forward([x, y]);
}

async function ensureProjDefinition(epsg) {
  const code = `EPSG:${epsg}`;
  if (proj4.defs(code)) return;
  const endpoints = [
    `https://epsg.io/${epsg}.proj4`,
    `https://spatialreference.org/ref/epsg/${epsg}/proj4/`,
  ];
  for (const url of endpoints) {
    const definition = await fetchProj4Definition(url);
    if (definition) {
      proj4.defs(code, definition);
      return;
    }
  }
  throw new Error(`CRS EPSG:${epsg} is not supported and could not be resolved at import time.`);
}

async function fetchProj4Definition(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const definition = (await response.text()).trim();
    return definition.startsWith("+proj=") ? definition : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function createAffineModel(inputs, worldPoints) {
  if (inputs.length !== worldPoints.length || inputs.length < 3) {
    throw new Error("GeoPDF control points do not define a stable transform.");
  }
  const controls = inputs.map(([u, v], index) => ({
    u,
    v,
    x: worldPoints[index][0],
    y: worldPoints[index][1],
  }));
  const coeffX = solveAffineAxis(controls, "x");
  const coeffY = solveAffineAxis(controls, "y");
  return {
    predict: (u, v) => [
      coeffX[0] * u + coeffX[1] * v + coeffX[2],
      coeffY[0] * u + coeffY[1] * v + coeffY[2],
    ],
  };
}

function solveAffineAxis(controls, axis) {
  let suu = 0;
  let suv = 0;
  let su = 0;
  let svv = 0;
  let sv = 0;
  let bu = 0;
  let bv = 0;
  let b1 = 0;
  controls.forEach((control) => {
    const { u, v } = control;
    const target = control[axis];
    suu += u * u;
    suv += u * v;
    su += u;
    svv += v * v;
    sv += v;
    bu += u * target;
    bv += v * target;
    b1 += target;
  });
  return solve3x3([
    [suu, suv, su],
    [suv, svv, sv],
    [su, sv, controls.length],
  ], [bu, bv, b1]);
}

function solve3x3(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < 3; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(augmented[bestRow][pivot]) < 1e-12) {
      throw new Error("GeoPDF control points do not define a stable transform.");
    }
    if (bestRow !== pivot) [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];
    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column < 4; column += 1) augmented[pivot][column] /= pivotValue;
    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column < 4; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return [augmented[0][3], augmented[1][3], augmented[2][3]];
}

function calculateFitErrorMeters(model, inputs, worldPoints) {
  const squaredErrors = inputs.map(([u, v], index) => {
    const distance = haversineMeters(model.predict(u, v), worldPoints[index]);
    return distance * distance;
  });
  return Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / squaredErrors.length);
}

function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const radius = 6371008.8;
  const toRadians = (value) => value * Math.PI / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function validateControlSpread(points) {
  const bounds = boundsFromCorners(points);
  if (!isValidBounds(bounds)) throw new Error("GeoPDF control points have invalid geographic bounds.");
  if (bounds.east - bounds.west < 1e-6 || bounds.north - bounds.south < 1e-6) {
    throw new Error("GeoPDF control points have no meaningful geographic spread.");
  }
}

function normalizeBBox(values) {
  const minX = Math.min(values[0], values[2]);
  const maxX = Math.max(values[0], values[2]);
  const minY = Math.min(values[1], values[3]);
  const maxY = Math.max(values[1], values[3]);
  const width = maxX - minX;
  const height = maxY - minY;
  if (![minX, minY, maxX, maxY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { minX, minY, maxX, maxY, width, height };
}

function boundsOfPoints(points) {
  if (!points.length) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return normalizeBBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

function pdfBoxCorners(bbox) {
  return [
    [bbox.minX, bbox.maxY],
    [bbox.maxX, bbox.maxY],
    [bbox.maxX, bbox.minY],
    [bbox.minX, bbox.minY],
  ];
}

function toPairs(values) {
  const pairs = [];
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }
  return pairs;
}

function validateLngLatPair([lng, lat]) {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

function boundsFromCorners(corners) {
  const lngs = corners.map(([lng]) => lng);
  const lats = corners.map(([, lat]) => lat);
  return {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  };
}

function isValidBounds(bounds) {
  return Number.isFinite(bounds.west)
    && Number.isFinite(bounds.south)
    && Number.isFinite(bounds.east)
    && Number.isFinite(bounds.north)
    && bounds.east > bounds.west
    && bounds.north > bounds.south
    && Math.abs(bounds.west) <= 180
    && Math.abs(bounds.east) <= 180
    && Math.abs(bounds.south) <= 90
    && Math.abs(bounds.north) <= 90;
}
