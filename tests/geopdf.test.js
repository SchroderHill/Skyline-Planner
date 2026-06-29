import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { extractGeoPdfGeoreference } from "../src/geopdf-metadata.js";

const MAIN_GPTS = [
  -41.61830258849447, 172.79833656583887,
  -41.6183744452594, 172.84460803378988,
  -41.659902446144265, 172.7982068363903,
  -41.659974407355435, 172.8445080702944,
];
const MAIN_LPTS = [
  -0.0000026212755953, 0.9995433025394862,
  0.999866456847359, 0.9995433025394862,
  -0.0000026212755953, -0.000079855397006,
  0.999866456847359, -0.000079855397006,
];

describe("GeoPDF metadata", () => {
  it("uses geographic GPTS while retaining a QGIS projected CRS label", async () => {
    const pdf = await createOgcPdf([
      {
        bbox: [722.47, 13.17, 834.17, 192.30],
        gpts: [-41.49, 172.70, -41.49, 172.94, -41.79, 172.70, -41.79, 172.94],
        lpts: [0, 1, 1, 1, 0, 0, 1, 0],
        epsg: 2193,
      },
      {
        bbox: [16.208329898989902, 205.57799274531146, 825.7473871380473, 1175.7119837142857],
        gpts: MAIN_GPTS,
        lpts: MAIN_LPTS,
        epsg: 2193,
      },
    ]);

    const result = await extractGeoPdfGeoreference(pdf);

    expect(result.kind).toBe("ogc");
    expect(result.declaredEpsg).toBe(2193);
    expect(result.viewportBBox.width).toBeCloseTo(809.539057, 5);
    expect(result.viewportCoordinates[0][0]).toBeCloseTo(172.79833, 5);
    expect(result.viewportCoordinates[0][1]).toBeCloseTo(-41.61828, 5);
    expect(result.viewportCoordinates[2][0]).toBeCloseTo(172.84451, 5);
    expect(result.viewportCoordinates[2][1]).toBeCloseTo(-41.65997, 5);
    expect(result.fitErrorMeters).toBeLessThan(1);
  });

  it("parses ArcGIS-style key ordering and longitude/latitude GPTS", async () => {
    const pdf = await createOgcPdf([{
      bbox: [10, 20, 410, 620],
      gpts: [172, -41, 172.1, -41, 172, -41.1, 172.1, -41.1],
      lpts: [0, 1, 1, 1, 0, 0, 1, 0],
      epsg: 4326,
      arcGisOrder: true,
    }]);

    const result = await extractGeoPdfGeoreference(pdf);

    expect(result.declaredEpsg).toBe(4326);
    expect(result.viewportCoordinates[0][0]).toBeCloseTo(172, 8);
    expect(result.viewportCoordinates[0][1]).toBeCloseTo(-41, 8);
    expect(result.viewportCoordinates[2][0]).toBeCloseTo(172.1, 8);
    expect(result.viewportCoordinates[2][1]).toBeCloseTo(-41.1, 8);
  });

  it("supports structured LGIDict projected coordinates", async () => {
    const pdf = await createLgiPdf({ epsg: 2193 });
    const result = await extractGeoPdfGeoreference(pdf);

    expect(result.kind).toBe("lgi");
    expect(result.declaredEpsg).toBe(2193);
    expect(result.viewportBBox).toMatchObject({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(result.boundsLngLat.west).toBeGreaterThan(172);
    expect(result.boundsLngLat.east).toBeLessThan(174);
    expect(result.boundsLngLat.south).toBeGreaterThan(-42);
    expect(result.boundsLngLat.north).toBeLessThan(-40);
  });

  it("reports a projected LGIDict with no CRS as invalid metadata", async () => {
    const pdf = await createLgiPdf({ epsg: null });

    await expect(extractGeoPdfGeoreference(pdf)).rejects.toThrow(
      "Projected GeoPDF metadata has no usable CRS",
    );
  });

  it("reports malformed OGC control arrays as invalid metadata", async () => {
    const pdf = await createOgcPdf([{
      bbox: [10, 20, 410, 620],
      gpts: [-41, 172, -41, 172.1, -41.1, 172],
      lpts: [0, 1, 1, 1, 0, 0],
      epsg: 4326,
    }]);

    await expect(extractGeoPdfGeoreference(pdf)).rejects.toThrow(
      "Geospatial metadata was found, but it is invalid",
    );
  });

  it("distinguishes a plain PDF from invalid geospatial metadata", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    const pdf = await document.save();

    await expect(extractGeoPdfGeoreference(pdf)).rejects.toThrow(
      "No supported geospatial metadata was found on page 1",
    );
  });
});

async function createOgcPdf(viewports) {
  const document = await PDFDocument.create();
  const page = document.addPage([842, 1191]);
  const { context } = document;
  const viewportArray = context.obj([]);

  viewports.forEach((definition) => {
    const gcs = context.obj({
      Type: PDFName.of(definition.epsg === 4326 ? "GEOGCS" : "PROJCS"),
      EPSG: definition.epsg,
    });
    const measure = PDFDict.withContext(context);
    if (definition.arcGisOrder) {
      measure.set(PDFName.of("Type"), PDFName.of("Measure"));
      measure.set(PDFName.of("Subtype"), PDFName.of("GEO"));
    }
    measure.set(PDFName.of("GPTS"), context.obj(definition.gpts));
    measure.set(PDFName.of("LPTS"), context.obj(definition.lpts));
    measure.set(PDFName.of("GCS"), gcs);
    if (!definition.arcGisOrder) {
      measure.set(PDFName.of("Subtype"), PDFName.of("GEO"));
      measure.set(PDFName.of("Type"), PDFName.of("Measure"));
    }
    viewportArray.push(context.obj({
      Type: PDFName.of("Viewport"),
      BBox: definition.bbox,
      Measure: measure,
    }));
  });

  page.node.set(PDFName.of("VP"), viewportArray);
  return document.save({ useObjectStreams: true });
}

async function createLgiPdf({ epsg }) {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const { context } = document;
  const projection = epsg == null ? context.obj({}) : context.obj({ EPSG: epsg });
  page.node.set(PDFName.of("LGIDict"), context.obj({
    CTM: [10, 0, 0, 10, 1600000, 5400000],
    Neatline: [0, 0, 100, 0, 100, 100, 0, 100],
    Projection: projection,
  }));
  return document.save({ useObjectStreams: true });
}
