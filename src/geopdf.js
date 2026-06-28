import proj4 from "proj4";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";

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

const MAX_FILE_SIZE_BYTES = 35 * 1024 * 1024;
const MAX_RENDER_EDGE = 2400;

let workerConfigured = false;

export async function parseGeoPdf(file) {
  validateFile(file);
  configurePdfWorker();
  registerKnownCrsDefinitions();

  const buffer = await file.arrayBuffer();
  const rawText = decodePdfText(buffer);
  const georeference = await extractGeoreference(rawText);

  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const documentProxy = await loadingTask.promise;
  if (documentProxy.numPages < 1) {
    throw new Error("The PDF has no pages to import.");
  }

  const page = await documentProxy.getPage(1);
  const rendered = await renderPageAsImage(page);
  const imageCoordinates = deriveImageCoordinates(georeference, rendered);
  const boundsLngLat = boundsFromCorners(imageCoordinates);

  if (!isValidBounds(boundsLngLat)) {
    throw new Error("The GeoPDF georeference produced invalid bounds.");
  }

  return {
    imageDataUrl: rendered.imageDataUrl,
    width: rendered.width,
    height: rendered.height,
    pageCount: documentProxy.numPages,
    coordinates: imageCoordinates,
    boundsLngLat,
    crsCode: georeference.epsg,
    crsLabel: georeference.epsg ? `EPSG:${georeference.epsg}` : "EPSG:4326",
    transformRmse: georeference.rmse,
  };
}

function validateFile(file) {
  const isPdf = file?.type === "application/pdf" || /\.pdf$/i.test(file?.name ?? "");
  if (!isPdf) {
    throw new Error("Only PDF files are supported.");
  }
  if (!file?.size) {
    throw new Error("The selected file is empty.");
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("PDF is too large. Maximum supported size is 35 MB.");
  }
}

function configurePdfWorker() {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  workerConfigured = true;
}

function registerKnownCrsDefinitions() {
  proj4.defs("EPSG:4326", WGS84_DEF);
  Object.entries(KNOWN_EPSG_DEFS).forEach(([epsg, def]) => {
    proj4.defs(`EPSG:${epsg}`, def);
  });
}

function decodePdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let text = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return text;
}

async function extractGeoreference(rawText) {
  const gptsEntries = extractNumberArrayEntries(rawText, "GPTS");
  const lptsEntries = extractNumberArrayEntries(rawText, "LPTS");
  const bboxEntries = extractNumberArrayEntries(rawText, "BBox");

  const candidatePairs = buildControlArrayPairs(gptsEntries, lptsEntries, bboxEntries);
  if (!candidatePairs.length) {
    throw new Error("No geospatial control points (GPTS/LPTS) were found. This PDF cannot be georeferenced automatically.");
  }

  const epsg = extractEpsgCode(rawText);
  let bestCandidate = null;

  for (const pair of candidatePairs) {
    try {
      const candidate = await buildGeoreferenceCandidate(pair, epsg);
      if (isBetterGeoreferenceCandidate(candidate, bestCandidate)) {
        bestCandidate = candidate;
      }
    } catch {
      // Keep trying other control-point blocks in this PDF.
    }
  }

  if (!bestCandidate) {
    throw new Error("No valid georeferencing transform could be derived from this GeoPDF.");
  }

  if (!Number.isFinite(bestCandidate.rmse) || bestCandidate.rmse > 0.9) {
    throw new Error("The GeoPDF transform confidence is too low to import safely.");
  }

  return {
    epsg: bestCandidate.epsg,
    model: bestCandidate.model,
    rmse: bestCandidate.rmse,
    modelInputForPdfPoint: bestCandidate.modelInputForPdfPoint,
  };
}

async function buildGeoreferenceCandidate(pair, epsg) {
  const gPairsRaw = toPairs(pair.gpts);
  const lPairsRaw = toPairs(pair.lpts);
  const lPairsNorm = normalizeControlPairs(lPairsRaw);
  const bbox = normalizeBBox(pair.bbox);
  const lptSpace = detectLptSpace(lPairsRaw, bbox);
  const coordinateMode = detectCoordinateMode(gPairsRaw, epsg);
  const sourceEpsg = coordinateMode.isProjected ? ensureProjectedEpsg(epsg) : (epsg ?? 4326);

  const toWgs84 = await createToWgs84Transform(sourceEpsg);
  const sourceControlPairs = gPairsRaw.map((point) => normalizeGeoPair(point, coordinateMode));
  const wgsControlPairs = sourceControlPairs.map((point) => toWgs84(point));
  const model = chooseBestTransformModel(lPairsNorm.pairs, wgsControlPairs);
  const modelInputForPdfPoint = (pdfPoint, pageBounds) => {
    const rawLocal = pdfPointToLocalRaw(pdfPoint, pageBounds, bbox, lptSpace);
    return lPairsNorm.normalize(rawLocal, false);
  };

  const corners = [
    model.predict(0, 0),
    model.predict(1, 0),
    model.predict(1, 1),
    model.predict(0, 1),
  ];
  const validCorners = corners.map(validateLngLatPair);
  if (validCorners.some((corner) => corner === null)) {
    throw new Error("Candidate corners are outside valid coordinate ranges.");
  }

  const bounds = boundsFromCorners(validCorners);
  if (!isValidBounds(bounds)) {
    throw new Error("Candidate bounds are invalid.");
  }

  return {
    epsg: sourceEpsg,
    model,
    rmse: model.rmse,
    controlCoverage: coverageOfNormalizedPairs(lPairsNorm.pairs),
    area: Math.abs(polygonArea(validCorners)),
    bounds,
    hasBBox: Boolean(bbox),
    modelInputForPdfPoint,
  };
}

function isBetterGeoreferenceCandidate(candidate, currentBest) {
  if (!currentBest) return true;

  const candidateScore = georeferenceScore(candidate);
  const currentScore = georeferenceScore(currentBest);
  if (candidateScore < currentScore - 1e-10) return true;
  if (candidateScore > currentScore + 1e-10) return false;

  // If scores are effectively equal, prefer better control spread then lower RMSE.
  if (candidate.controlCoverage > currentBest.controlCoverage) return true;
  if (candidate.controlCoverage < currentBest.controlCoverage) return false;
  return candidate.rmse < currentBest.rmse;
}

function georeferenceScore(candidate) {
  return candidate.rmse
    + coveragePenalty(candidate.controlCoverage)
    + extentPenalty(candidate.bounds);
}

function coveragePenalty(coverage) {
  // Good control blocks span a meaningful portion of frame; tiny coverage is unstable.
  if (!Number.isFinite(coverage) || coverage <= 0) return 100;
  if (coverage < 0.02) return 20;
  if (coverage < 0.08) return 8;
  if (coverage < 0.2) return 2;
  return 0;
}

function extentPenalty(bounds) {
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  // Penalize implausibly huge extents that usually indicate a wrong control block match.
  if (lonSpan > 25 || latSpan > 25) return 40;
  if (lonSpan > 10 || latSpan > 10) return 12;
  if (lonSpan > 5 || latSpan > 5) return 3;
  return 0;
}

function extractNumberArrayEntries(rawText, key) {
  const entries = [];
  const pattern = new RegExp(`\\/${key}\\s*\\[([^\\]]+)\\]`, "gi");
  let match;
  while ((match = pattern.exec(rawText)) !== null) {
    const values = parseNumberList(match[1]);
    if (values.length >= 8 && values.length % 2 === 0) {
      entries.push({ values, index: match.index });
    }
    if (key.toLowerCase() === "bbox" && values.length === 4) {
      entries.push({ values, index: match.index });
    }
  }
  return entries;
}

function parseNumberList(value) {
  return (value.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [])
    .map((token) => Number(token))
    .filter((number) => Number.isFinite(number));
}

function buildControlArrayPairs(gptsEntries, lptsEntries, bboxEntries) {
  const pairs = [];
  for (const gpts of gptsEntries) {
    const matchingLpts = lptsEntries
      .filter((lpts) => lpts.values.length === gpts.values.length && gpts.values.length >= 8)
      .map((lpts) => ({ lpts, distance: Math.abs(lpts.index - gpts.index) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);

    matchingLpts.forEach(({ lpts }) => {
      const indexHint = (gpts.index + lpts.index) / 2;
      const bbox = nearestBBox(indexHint, bboxEntries)?.values ?? null;
      pairs.push({ gpts: gpts.values, lpts: lpts.values, bbox });
    });
  }
  return pairs;
}

function nearestBBox(indexHint, bboxEntries) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of bboxEntries) {
    if (!Array.isArray(entry.values) || entry.values.length !== 4) continue;
    const distance = Math.abs(entry.index - indexHint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  if (!best) return null;
  return bestDistance <= 4000 ? best : null;
}

function extractEpsgCode(rawText) {
  const patterns = [
    /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d{4,6})"\s*\]/i,
    /EPSG\s*[:=\s]\s*(\d{4,6})/i,
    /EPSG\D{0,12}(\d{4,6})/i,
  ];
  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match?.[1]) {
      const epsg = Number(match[1]);
      if (Number.isInteger(epsg) && epsg > 0) return epsg;
    }
  }
  return null;
}

function toPairs(values) {
  const pairs = [];
  for (let i = 0; i < values.length; i += 2) {
    pairs.push([values[i], values[i + 1]]);
  }
  return pairs;
}

function normalizeControlPairs(pairs) {
  const xs = pairs.map((pair) => pair[0]);
  const ys = pairs.map((pair) => pair[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  if (rangeX <= 0 || rangeY <= 0) {
    throw new Error("GeoPDF control points are degenerate.");
  }

  const alreadyNormalized = minX >= -0.05 && maxX <= 1.05 && minY >= -0.05 && maxY <= 1.05;
  const normalize = ([x, y], clamp = false) => {
    const nx = alreadyNormalized ? x : (x - minX) / rangeX;
    const ny = alreadyNormalized ? y : (y - minY) / rangeY;
    return clamp ? [clamp01(nx), clamp01(ny)] : [nx, ny];
  };

  return {
    pairs: pairs.map((point) => normalize(point, false)),
    normalize,
    minX,
    minY,
    maxX,
    maxY,
    rangeX,
    rangeY,
    alreadyNormalized,
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function detectCoordinateMode(pairs, epsg) {
  const latLon = pairs.every(([a, b]) => Math.abs(a) <= 90 && Math.abs(b) <= 180);
  const lonLat = pairs.every(([a, b]) => Math.abs(a) <= 180 && Math.abs(b) <= 90);

  if (!latLon && !lonLat && epsg && epsg !== 4326) {
    return {
      isProjected: true,
      order: "xy",
    };
  }

  if (latLon || lonLat) {
    return {
      isProjected: false,
      order: latLon ? "latlon" : "lonlat",
    };
  }

  return {
    isProjected: true,
    order: "xy",
  };
}

function detectLptSpace(lptPairs, bbox) {
  const xs = lptPairs.map((pair) => pair[0]);
  const ys = lptPairs.map((pair) => pair[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const inNormalizedRange = minX >= -0.1 && maxX <= 1.1 && minY >= -0.1 && maxY <= 1.1;
  if (inNormalizedRange) return "normalized";

  if (bbox) {
    const tolX = Math.max(1, bbox.width * 0.05);
    const tolY = Math.max(1, bbox.height * 0.05);
    const looksLikePageUnits =
      minX >= bbox.minX - tolX
      && maxX <= bbox.maxX + tolX
      && minY >= bbox.minY - tolY
      && maxY <= bbox.maxY + tolY;
    if (looksLikePageUnits) return "page";
  }

  return (Math.abs(maxX - minX) > 2 || Math.abs(maxY - minY) > 2) ? "page" : "normalized";
}

function pdfPointToLocalRaw(pdfPoint, pageBounds, bbox, lptSpace) {
  const [x, y] = pdfPoint;
  if (lptSpace === "page") {
    return [x, y];
  }
  if (bbox) {
    return [
      (x - bbox.minX) / bbox.width,
      (y - bbox.minY) / bbox.height,
    ];
  }
  return [
    (x - pageBounds.minX) / pageBounds.width,
    (y - pageBounds.minY) / pageBounds.height,
  ];
}

function normalizeBBox(values) {
  if (!Array.isArray(values) || values.length < 4) return null;
  const minX = Math.min(values[0], values[2]);
  const maxX = Math.max(values[0], values[2]);
  const minY = Math.min(values[1], values[3]);
  const maxY = Math.max(values[1], values[3]);
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { minX, minY, maxX, maxY, width, height };
}

function ensureProjectedEpsg(epsg) {
  if (!epsg) {
    throw new Error("Projected coordinates were detected but no EPSG code was found in the GeoPDF.");
  }
  return epsg;
}

function normalizeGeoPair(pair, mode) {
  if (mode.order === "latlon") {
    return [pair[1], pair[0]];
  }
  return [...pair];
}

async function createToWgs84Transform(epsg) {
  if (epsg === 4326) {
    return ([x, y]) => [x, y];
  }

  await ensureProjDefinition(epsg);
  const converter = proj4(`EPSG:${epsg}`, "EPSG:4326");
  return ([x, y]) => converter.forward([x, y]);
}

async function ensureProjDefinition(epsg) {
  const code = `EPSG:${epsg}`;
  if (proj4.defs(code)) return;

  const knownDef = KNOWN_EPSG_DEFS[epsg];
  if (knownDef) {
    proj4.defs(code, knownDef);
    return;
  }

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
    const text = (await response.text()).trim();
    if (!text.startsWith("+proj=")) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function chooseBestTransformModel(controlLpts, controlWgs) {
  const modelA = createAffineModel(controlLpts, controlWgs, false);
  const modelB = createAffineModel(controlLpts, controlWgs, true);
  return modelA.rmse <= modelB.rmse ? modelA : modelB;
}

function createAffineModel(lpts, worldPoints, invertY) {
  const controls = lpts.map((point, index) => {
    const u = point[0];
    const v = invertY ? 1 - point[1] : point[1];
    return { u, v, x: worldPoints[index][0], y: worldPoints[index][1] };
  });

  const coeffX = solveAffineAxis(controls, "x");
  const coeffY = solveAffineAxis(controls, "y");

  const predict = (u, vImage) => {
    const v = invertY ? 1 - vImage : vImage;
    return [
      coeffX[0] * u + coeffX[1] * v + coeffX[2],
      coeffY[0] * u + coeffY[1] * v + coeffY[2],
    ];
  };

  const mse = controls.reduce((sum, control) => {
    const [px, py] = predict(control.u, invertY ? 1 - control.v : control.v);
    const dx = px - control.x;
    const dy = py - control.y;
    return sum + dx * dx + dy * dy;
  }, 0) / Math.max(1, controls.length);

  return {
    predict,
    rmse: Math.sqrt(mse),
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
    const t = control[axis];
    suu += u * u;
    suv += u * v;
    su += u;
    svv += v * v;
    sv += v;
    bu += u * t;
    bv += v * t;
    b1 += t;
  });

  const matrix = [
    [suu, suv, su],
    [suv, svv, sv],
    [su, sv, controls.length],
  ];
  const vector = [bu, bv, b1];
  return solve3x3(matrix, vector);
}

function solve3x3(matrix, vector) {
  const m = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);

  for (let pivot = 0; pivot < 3; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(m[row][pivot]) > Math.abs(m[bestRow][pivot])) {
        bestRow = row;
      }
    }

    if (Math.abs(m[bestRow][pivot]) < 1e-12) {
      throw new Error("GeoPDF control points do not define a stable transform.");
    }

    if (bestRow !== pivot) {
      [m[pivot], m[bestRow]] = [m[bestRow], m[pivot]];
    }

    const pivotValue = m[pivot][pivot];
    for (let column = pivot; column < 4; column += 1) {
      m[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = m[row][pivot];
      for (let column = pivot; column < 4; column += 1) {
        m[row][column] -= factor * m[pivot][column];
      }
    }
  }

  return [m[0][3], m[1][3], m[2][3]];
}

async function renderPageAsImage(page) {
  const baseViewport = page.getViewport({ scale: 1 });
  const edge = Math.max(baseViewport.width, baseViewport.height);
  const scale = edge > MAX_RENDER_EDGE ? MAX_RENDER_EDGE / edge : 1;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("Unable to create a canvas context for PDF rendering.");
  }

  await page.render({ canvasContext: context, viewport }).promise;
  const pdfCorners = [
    viewport.convertToPdfPoint(0, 0),
    viewport.convertToPdfPoint(canvas.width, 0),
    viewport.convertToPdfPoint(canvas.width, canvas.height),
    viewport.convertToPdfPoint(0, canvas.height),
  ];
  const pdfBounds = {
    minX: Math.min(...pdfCorners.map((point) => point[0])),
    minY: Math.min(...pdfCorners.map((point) => point[1])),
    maxX: Math.max(...pdfCorners.map((point) => point[0])),
    maxY: Math.max(...pdfCorners.map((point) => point[1])),
  };
  pdfBounds.width = pdfBounds.maxX - pdfBounds.minX;
  pdfBounds.height = pdfBounds.maxY - pdfBounds.minY;

  return {
    imageDataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    pdfCorners,
    pdfBounds,
  };
}

function deriveImageCoordinates(georeference, rendered) {
  const corners = rendered.pdfCorners.map((pdfPoint) => {
    const [u, v] = georeference.modelInputForPdfPoint(pdfPoint, rendered.pdfBounds);
    return georeference.model.predict(u, v);
  });

  const validCorners = corners.map(validateLngLatPair);
  if (validCorners.some((corner) => corner === null)) {
    throw new Error("Reprojected GeoPDF corners are outside valid map coordinate ranges.");
  }

  if (rendered.width < 2 || rendered.height < 2) {
    throw new Error("Rendered GeoPDF image is too small to display.");
  }

  const bounds = boundsFromCorners(validCorners);
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  if (lonSpan < 1e-6 || latSpan < 1e-6) {
    throw new Error("GeoPDF control points collapse to an invalid map footprint.");
  }

  return validCorners;
}

function validateLngLatPair(pair) {
  const [lng, lat] = pair;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

function boundsFromCorners(corners) {
  const lngs = corners.map((corner) => corner[0]);
  const lats = corners.map((corner) => corner[1]);
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
    && Math.abs(bounds.north) <= 90
    && Math.abs(bounds.south) <= 90
    && Math.abs(bounds.east) <= 180
    && Math.abs(bounds.west) <= 180;
}

function polygonArea(corners) {
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function coverageOfNormalizedPairs(pairs) {
  if (!pairs.length) return 0;
  const xs = pairs.map((pair) => pair[0]);
  const ys = pairs.map((pair) => pair[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  return width * height;
}
