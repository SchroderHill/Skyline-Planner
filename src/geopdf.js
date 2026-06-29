import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/build/pdf.mjs";
import { extractGeoPdfGeoreference } from "./geopdf-metadata.js";

const MAX_FILE_SIZE_BYTES = 35 * 1024 * 1024;
const MAX_RENDER_EDGE = 2400;

let workerConfigured = false;

export async function parseGeoPdf(file) {
  validateFile(file);
  configurePdfWorker();

  const buffer = await file.arrayBuffer();
  const georeference = await extractGeoPdfGeoreference(buffer);
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const documentProxy = await loadingTask.promise;
  if (documentProxy.numPages < 1) {
    throw new Error("The PDF has no pages to import.");
  }

  const page = await documentProxy.getPage(1);
  const rendered = await renderViewportAsImage(page, georeference.viewportBBox);
  const imageCoordinates = rendered.pdfCorners.map(georeference.projectPdfPoint);
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
    crsCode: georeference.declaredEpsg,
    crsLabel: georeference.crsLabel,
    fitErrorMeters: georeference.fitErrorMeters,
    fitWarning: georeference.fitWarning,
  };
}

function validateFile(file) {
  const isPdf = file?.type === "application/pdf" || /\.pdf$/i.test(file?.name ?? "");
  if (!isPdf) throw new Error("Only PDF files are supported.");
  if (!file?.size) throw new Error("The selected file is empty.");
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error("PDF is too large. Maximum supported size is 35 MB.");
  }
}

function configurePdfWorker() {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  workerConfigured = true;
}

async function renderViewportAsImage(page, viewportBBox) {
  const baseViewport = page.getViewport({ scale: 1 });
  const pageEdge = Math.max(baseViewport.width, baseViewport.height);
  const scale = pageEdge > MAX_RENDER_EDGE ? MAX_RENDER_EDGE / pageEdge : 1;
  const viewport = page.getViewport({ scale });

  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = Math.max(1, Math.round(viewport.width));
  pageCanvas.height = Math.max(1, Math.round(viewport.height));
  const pageContext = pageCanvas.getContext("2d", { alpha: true });
  if (!pageContext) throw new Error("Unable to create a canvas context for PDF rendering.");

  await page.render({ canvasContext: pageContext, viewport }).promise;

  const viewportPdfCorners = [
    [viewportBBox.minX, viewportBBox.maxY],
    [viewportBBox.maxX, viewportBBox.maxY],
    [viewportBBox.maxX, viewportBBox.minY],
    [viewportBBox.minX, viewportBBox.minY],
  ];
  const viewportPixels = viewportPdfCorners.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const pixelXs = viewportPixels.map(([x]) => x);
  const pixelYs = viewportPixels.map(([, y]) => y);
  const left = clamp(Math.floor(Math.min(...pixelXs)), 0, pageCanvas.width);
  const top = clamp(Math.floor(Math.min(...pixelYs)), 0, pageCanvas.height);
  const right = clamp(Math.ceil(Math.max(...pixelXs)), 0, pageCanvas.width);
  const bottom = clamp(Math.ceil(Math.max(...pixelYs)), 0, pageCanvas.height);
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) {
    throw new Error("The selected geospatial viewport is outside the rendered PDF page.");
  }

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = width;
  cropCanvas.height = height;
  const cropContext = cropCanvas.getContext("2d", { alpha: true });
  if (!cropContext) throw new Error("Unable to create a canvas context for GeoPDF cropping.");
  cropContext.drawImage(pageCanvas, left, top, width, height, 0, 0, width, height);

  const pdfCorners = [
    viewport.convertToPdfPoint(left, top),
    viewport.convertToPdfPoint(right, top),
    viewport.convertToPdfPoint(right, bottom),
    viewport.convertToPdfPoint(left, bottom),
  ];

  return {
    imageDataUrl: cropCanvas.toDataURL("image/png"),
    width,
    height,
    pdfCorners,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
