import mapboxgl from "mapbox-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import {
  baseMapLayerOpacity,
  baseMapStyleFor,
  DEFAULT_BASE_MAP_MODE,
  normalizeBaseMapMode
} from "./basemap.js";
import { distance } from "./clearance.js";
import { formatArea, polygonAreaSquareMetres, polygonCentroid } from "./geometry.js";

export const DEFAULT_MAP_VIEW = {
  center: [173.52, -41.25],
  zoom: 10.5
};

const COLORS = { green: "#178f48", red: "#d71920", neutral: "#2d3748" };
const SOURCE_IDS = {
  linzHillshade: "linz-hillshade-overlay",
  googleSatellite: "google-satellite-overlay",
  sentinel2: "sentinel2-overlay",
  linzParcels: "linz-parcels",
  setting: "setting-overlay",
  skid: "skid-overlay",
  corridors: "corridor-base",
  results: "result-segments",
  labels: "skyline-labels",
  vertexPulse: "vertex-pulse",
  geotiffFootprint: "geotiff-footprint",
  userLocation: "user-location"
};
const LAYER_IDS = {
  linzHillshade: "linz-hillshade-overlay-layer",
  googleSatellite: "google-satellite-overlay-layer",
  sentinel2: "sentinel2-overlay-layer",
  linzParcelsFill: "linz-parcels-fill",
  linzParcelsLine: "linz-parcels-line",
  linzParcelsLabel: "linz-parcels-label"
};
const TERRAIN_SOURCE_ID = "mapbox-terrain-dem";
export function createMap(container, state, onGeometryChange) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  const linzApiKey = import.meta.env.VITE_LINZ_API_KEY;
  const linzLdsKey = import.meta.env.VITE_LINZ_LDS_KEY;
  const sentinelInstanceId = import.meta.env.VITE_SENTINEL_INSTANCE_ID;
  if (!token) return createFallbackMap(container, state, onGeometryChange);

  let currentState = state;
  let currentBaseMode = normalizeBaseMapMode(state.baseMapMode);
  let currentBaseStyle = baseMapStyleFor(currentBaseMode);
  let styleLoading = false;
  let styleRevision = 0;
  let initializedStyleRevision = -1;
  let pendingDrawMode = null;
  mapboxgl.accessToken = token;
  let map;
  try {
    map = new mapboxgl.Map({
      container,
      style: currentBaseStyle,
      center: DEFAULT_MAP_VIEW.center,
      zoom: DEFAULT_MAP_VIEW.zoom,
      preserveDrawingBuffer: true
    });
  } catch (error) {
    console.error("Map initialization failed. Falling back to no-map mode.", error);
    return createFallbackMap(
      container,
      state,
      onGeometryChange,
      "Map failed to initialize. The prototype is running in no-map mode."
    );
  }
  const draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: { point: true, polygon: true, line_string: true, trash: true }
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  map.addControl(draw, "top-left");
  renameDrawControls(container);
  addLegend(container);

  const loadingOverlay = document.createElement("div");
  loadingOverlay.className = "sentinel-loading";
  loadingOverlay.innerHTML = `
    <div class="sentinel-loading__inner">
      <svg class="sentinel-loading__spinner" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="32" stroke-dashoffset="12"/>
      </svg>
      <span>Loading Sentinel-2 imagery&hellip;</span>
      <small>Fetching least-cloudy scenes (&lt;5% cloud) from the last 90 days</small>
    </div>
  `;
  container.appendChild(loadingOverlay);

  let sentinelLoadingDone = false;
  let sentinelLoadingTimer = null;
  const skylinePopup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
    className: "skyline-profile-popup"
  });
  let skylineHoverEventsBound = false;
  let fieldModeEditEnabled = false;
  let selectedDrawFeatureIds = [];
  let activeProfileSkylineId = null;

  function hideSentinelOverlay() {
    sentinelLoadingDone = true;
    clearTimeout(sentinelLoadingTimer);
    sentinelLoadingTimer = null;
    loadingOverlay.classList.remove("sentinel-loading--visible");
  }

  map.on("sourcedataloading", (e) => {
    if (!sentinelLoadingDone && e.sourceId === SOURCE_IDS.sentinel2 && currentState.baseMapMode === "sentinel-2") {
      loadingOverlay.classList.add("sentinel-loading--visible");
      if (!sentinelLoadingTimer) {
        sentinelLoadingTimer = setTimeout(hideSentinelOverlay, 7000);
      }
    }
  });
  map.on("idle", () => {
    if (loadingOverlay.classList.contains("sentinel-loading--visible")) {
      hideSentinelOverlay();
    }
  });
  map.on("error", () => {
    if (loadingOverlay.classList.contains("sentinel-loading--visible")) {
      hideSentinelOverlay();
    }
  });

  function styleDrawVertices() {
    // Make MapboxDraw's vertex dots larger and clearly styled (white circle, green border)
    const vertexDotLayers = [
      "gl-draw-polygon-and-line-vertex-inactive.cold",
      "gl-draw-polygon-and-line-vertex-inactive.hot",
    ];
    const vertexHaloLayers = [
      "gl-draw-polygon-and-line-vertex-stroke-inactive.cold",
      "gl-draw-polygon-and-line-vertex-stroke-inactive.hot",
    ];
    vertexDotLayers.forEach((id) => {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, "circle-radius", 6);
        map.setPaintProperty(id, "circle-color", "#ffffff");
      }
    });
    vertexHaloLayers.forEach((id) => {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, "circle-radius", 10);
        map.setPaintProperty(id, "circle-color", "#1a8f3c");
      }
    });
  }

  // --- User layer tracking ---
  // Keeps track of which user layer IDs have been added to the map.
  // Must be cleared whenever the style reloads (all sources are wiped).
  const userLayerIds = new Set();
  const geoPdfOverlayIds = new Set();

  function geoPdfSourceId(overlayId) {
    return `geopdf-overlay-${overlayId}`;
  }

  function geoPdfLayerId(overlayId) {
    return `${geoPdfSourceId(overlayId)}-raster`;
  }

  function addUserLayerToMap(layer) {
    const sourceId = `user-layer-${layer.id}`;
    if (map.getSource(sourceId)) return;
    map.addSource(sourceId, {
      type: "geojson",
      data: layer.visible ? layer.geojson : emptyCollection()
    });
    const color = layer.color ?? "#3B82F6";
    map.addLayer({
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": color, "fill-opacity": 0.2 }
    });
    map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      filter: ["any", ["==", ["geometry-type"], "LineString"], ["==", ["geometry-type"], "Polygon"]],
      paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 }
    });
    map.addLayer({
      id: `${sourceId}-circle`,
      type: "circle",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5
      }
    });
    userLayerIds.add(layer.id);
  }

  function removeUserLayerFromMap(layerId) {
    const sourceId = `user-layer-${layerId}`;
    [`${sourceId}-fill`, `${sourceId}-line`, `${sourceId}-circle`].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    userLayerIds.delete(layerId);
  }

  function syncUserLayers(state) {
    const layers = state.userLayers ?? [];
    const stateIds = new Set(layers.map((l) => l.id));
    // Remove layers no longer in state
    for (const id of [...userLayerIds]) {
      if (!stateIds.has(id)) removeUserLayerFromMap(id);
    }
    // Add new layers; update data for existing ones
    for (const layer of layers) {
      const sourceId = `user-layer-${layer.id}`;
      if (!map.getSource(sourceId)) {
        addUserLayerToMap(layer);
      } else {
        map.getSource(sourceId).setData(layer.visible ? layer.geojson : emptyCollection());
      }
    }
  }

  function addGeoPdfOverlayToMap(overlay) {
    const sourceId = geoPdfSourceId(overlay.id);
    const layerId = geoPdfLayerId(overlay.id);
    if (map.getSource(sourceId)) return;
    map.addSource(sourceId, {
      type: "image",
      url: overlay.imageDataUrl,
      coordinates: overlay.coordinates
    });
    const beforeLayerId = map.getLayer("setting-fill") ? "setting-fill" : undefined;
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: {
        "raster-opacity": overlay.visible ? Number(overlay.opacity ?? 0.65) : 0,
        "raster-fade-duration": 0
      }
    }, beforeLayerId);
    geoPdfOverlayIds.add(overlay.id);
  }

  function removeGeoPdfOverlayFromMap(overlayId) {
    const sourceId = geoPdfSourceId(overlayId);
    const layerId = geoPdfLayerId(overlayId);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    geoPdfOverlayIds.delete(overlayId);
  }

  function syncGeoPdfOverlays(state) {
    const overlays = state.geopdfOverlays ?? [];
    const stateIds = new Set(overlays.map((overlay) => overlay.id));

    for (const id of [...geoPdfOverlayIds]) {
      if (!stateIds.has(id)) removeGeoPdfOverlayFromMap(id);
    }

    for (const overlay of overlays) {
      const sourceId = geoPdfSourceId(overlay.id);
      const layerId = geoPdfLayerId(overlay.id);
      if (!map.getSource(sourceId)) {
        addGeoPdfOverlayToMap(overlay);
      } else {
        const source = map.getSource(sourceId);
        if (typeof source.updateImage === "function") {
          source.updateImage({
            url: overlay.imageDataUrl,
            coordinates: overlay.coordinates
          });
        }
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, "raster-opacity", overlay.visible ? Number(overlay.opacity ?? 0.65) : 0);
        }
      }
      geoPdfOverlayIds.add(overlay.id);
    }
  }

  function initStyleLayers(revision = styleRevision) {
    if (revision !== styleRevision || initializedStyleRevision === revision) return;
    initializedStyleRevision = revision;
    styleLoading = false;
    userLayerIds.clear(); // style reload wipes all sources
    geoPdfOverlayIds.clear();
    addBaseMapLayers(map, linzApiKey, sentinelInstanceId, currentBaseMode);
    applyBaseMapMode(map, currentBaseMode);
    addTerrainSource(map);
    addParcelLayer(map);
    replaceDrawFeatures(currentState);
    addProjectLayers(map);
    syncGeoPdfOverlays(currentState);
    renderProjectMap(map, currentState);
    bindSkylineHoverEvents();
    syncUserLayers(currentState);
    fetchParcels(map, linzLdsKey);
    styleDrawVertices();
    if (pendingDrawMode) {
      const modeToRestore = pendingDrawMode;
      pendingDrawMode = null;
      // Defer slightly so draw control finishes its own style.load handler first
      setTimeout(() => draw.changeMode(modeToRestore), 0);
    }
  }

  function loadBaseStyle(style) {
    const revision = ++styleRevision;
    initializedStyleRevision = -1;
    styleLoading = true;
    map.setStyle(style);
    map.once("style.load", () => initStyleLayers(revision));
  }

  map.on("load", () => initStyleLayers(styleRevision));
  map.on("moveend", () => fetchParcels(map, linzLdsKey));

  function bindSkylineHoverEvents() {
    if (skylineHoverEventsBound) return;
    skylineHoverEventsBound = true;

    const showPopup = (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const skylineId = skylineIdFromFeature(feature);
      if (!skylineId) return;
      activeProfileSkylineId = skylineId;
      const popupHtml = skylineProfilePopupHtml(currentState, skylineId);
      const lngLat = event.lngLat ?? map.unproject(eventPoint(event));
      map.getCanvas().style.cursor = "pointer";
      skylinePopup
        .setLngLat(lngLat)
        .setHTML(popupHtml)
        .addTo(map);
    };

    const hideFieldPopup = () => {
      activeProfileSkylineId = null;
      map.getCanvas().style.cursor = "";
      skylinePopup.remove();
    };

    const corridorLayers = () => ["corridor-base", "result-segments"].filter((layerId) => map.getLayer(layerId));
    const corridorFeatureAtPoint = (point, tolerancePx = 18) => {
      const layers = corridorLayers();
      if (!point) return null;
      if (layers.length) {
        const hits = map.queryRenderedFeatures([
          [point.x - tolerancePx, point.y - tolerancePx],
          [point.x + tolerancePx, point.y + tolerancePx]
        ], { layers });
        const layerHit = hits.find((candidate) => skylineIdFromFeature(candidate));
        if (layerHit) return layerHit;
      }
      return skylineFeatureNearPoint(point, tolerancePx);
    };

    const skylineFeatureNearPoint = (point, tolerancePx) => {
      let closest = null;
      (currentState.skylines ?? []).forEach((skyline, index) => {
        const coordinates = skyline.coordinates ?? [];
        coordinates.slice(1).forEach((coordinate, coordinateIndex) => {
          const start = map.project(coordinates[coordinateIndex]);
          const end = map.project(coordinate);
          const distancePx = distanceToSegment(point, start, end);
          if (distancePx <= tolerancePx && (!closest || distancePx < closest.distancePx)) {
            const skylineId = skyline.id ?? skylineLabel(index);
            closest = {
              distancePx,
              feature: {
                properties: {
                  skylineId,
                  label: skylineId
                }
              }
            };
          }
        });
      });
      return closest?.feature ?? null;
    };

    const eventPoint = (event) => event.point ?? event.points?.[0] ?? null;

    const showFieldPopup = (event, feature = event.features?.[0]) => {
      if (!currentState.isFieldMode) return;
      event.preventDefault?.();
      if (!feature) return;
      fieldModeEditEnabled = false;
      showPopup({ ...event, features: [feature] });
    };

    const hidePopup = () => {
      if (currentState.isFieldMode) return;
      map.getCanvas().style.cursor = "";
      skylinePopup.remove();
    };

    document.addEventListener("pointerdown", (event) => {
      if (!currentState.isFieldMode) return;
      if (event.target.closest?.(".mapboxgl-popup")) return;
      if (event.target.closest?.(".mapbox-gl-draw_trash")) return;
      hideFieldPopup();
    }, { capture: true });

    ["corridor-base", "result-segments"].forEach((layerId) => {
      map.on("mouseenter", layerId, (event) => {
        if (!currentState.isFieldMode) showPopup(event);
      });
      map.on("mousemove", layerId, (event) => {
        if (!currentState.isFieldMode) showPopup(event);
      });
      map.on("mouseleave", layerId, hidePopup);
    });

    map.on("click", (event) => {
      if (!currentState.isFieldMode) return;
      const feature = corridorFeatureAtPoint(eventPoint(event));
      if (feature) {
        showFieldPopup(event, feature);
      } else {
        hideFieldPopup();
      }
    });

    map.on("touchend", (event) => {
      if (!currentState.isFieldMode) return;
      const point = eventPoint(event);
      const feature = corridorFeatureAtPoint(point, 24);
      if (feature) showFieldPopup(event, feature);
    });
  }

  // Disable double-click zoom so it never conflicts with editing features.
  // Users can still zoom with scroll, pinch, or the +/- navigation buttons.
  map.doubleClickZoom.disable();

  // --- Pulsing vertex animation ---
  let pulseAnimId = null;

  function updatePulseVertices(feature) {
    if (!map.getSource(SOURCE_IDS.vertexPulse)) return;
    const raw = feature.geometry.type === "LineString"
      ? feature.geometry.coordinates
      : feature.geometry.coordinates[0].slice(0, -1); // drop closing duplicate
    map.getSource(SOURCE_IDS.vertexPulse).setData({
      type: "FeatureCollection",
      features: raw.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }))
    });
  }

  function startPulse() {
    if (pulseAnimId) return;
    const t0 = performance.now();
    function frame(now) {
      const t = ((now - t0) % 1500) / 1500;  // 1.5 s cycle
      const radius = 8 + t * 26;             // expand 8 → 34 px
      const opacity = 0.65 * (1 - t);        // fade out
      if (map.getLayer("vertex-pulse-ring")) {
        map.setPaintProperty("vertex-pulse-ring", "circle-radius", radius);
        map.setPaintProperty("vertex-pulse-ring", "circle-opacity", opacity);
      }
      pulseAnimId = requestAnimationFrame(frame);
    }
    pulseAnimId = requestAnimationFrame(frame);
  }

  function stopPulse() {
    if (pulseAnimId) {
      cancelAnimationFrame(pulseAnimId);
      pulseAnimId = null;
    }
    if (map.getSource(SOURCE_IDS.vertexPulse)) {
      map.getSource(SOURCE_IDS.vertexPulse).setData(emptyCollection());
    }
    if (map.getLayer("vertex-pulse-ring")) {
      map.setPaintProperty("vertex-pulse-ring", "circle-opacity", 0);
    }
  }

  function deleteSelectedDrawFeatures() {
    const selectedIds = typeof draw.getSelectedIds === "function"
      ? draw.getSelectedIds()
      : draw.getSelected().features.map((feature) => feature.id);
    const profileFeatureId = activeProfileSkylineId ? drawFeatureIdForSkyline(activeProfileSkylineId) : null;
    const idsToDelete = currentState.isFieldMode && profileFeatureId
      ? [profileFeatureId]
      : selectedIds.length
      ? selectedIds
      : selectedDrawFeatureIds.length
        ? selectedDrawFeatureIds
        : profileFeatureId ? [profileFeatureId] : [];
    if (!idsToDelete.length) return;

    stopPulse();
    fieldModeEditEnabled = false;
    activeProfileSkylineId = null;
    selectedDrawFeatureIds = [];
    skylinePopup.remove();
    isBlurring = true;
    try {
      draw.changeMode("simple_select");
    } finally {
      isBlurring = false;
    }
    draw.delete(idsToDelete);
    // onGeometryChange is called by the draw.delete event handler
  }

  function drawFeatureIdForSkyline(skylineId) {
    const feature = draw.getAll().features.find((candidate) =>
      candidate.geometry.type === "LineString"
      && String(candidate.properties?.skylineId ?? candidate.id).replace(/^skyline-/, "") === String(skylineId)
    );
    if (feature) return feature.id;
    // Positional fallback for freshly-drawn skylines that have MapboxDraw UUID IDs
    // and no skylineId property yet (restoreDrawFeatures hasn't run since they were drawn).
    // readDrawFeatures assigns sequential IDs in the same order, so index 0 === id "1" etc.
    const lines = draw.getAll().features.filter((f) => f.geometry.type === "LineString");
    const index = Number(skylineId) - 1;
    return lines[index]?.id ?? null;
  }

  bindDrawTrashControl(container, deleteSelectedDrawFeatures);

  // As soon as a line or polygon is selected, jump straight into vertex-edit
  // (direct_select) mode and start the pulse so edit state is unmistakable.
  map.on("draw.selectionchange", (e) => {
    if (isBlurring) return;  // don't fight back against blur()
    const feature = e.features?.[0];
    if (!feature) {
      selectedDrawFeatureIds = [];
      stopPulse();
      return;
    }
    selectedDrawFeatureIds = e.features.map((selectedFeature) => selectedFeature.id).filter(Boolean);
    if (
      currentState.isFieldMode
      && feature.geometry.type === "LineString"
      && !fieldModeEditEnabled
    ) {
      stopPulse();
      if (draw.getMode() !== "simple_select") {
        isBlurring = true;
        try {
          draw.changeMode("simple_select");
        } finally {
          isBlurring = false;
        }
      }
      return;
    }
    if (feature.geometry.type === "LineString" || feature.geometry.type === "Polygon") {
      if (draw.getMode() === "simple_select") {
        draw.changeMode("direct_select", { featureId: feature.id });
      }
      updatePulseVertices(feature);
      startPulse();
    } else {
      stopPulse();
    }
  });

  // Stop pulsing when the user switches to a draw tool or deselects everything
  map.on("draw.modechange", (e) => {
    if (e.mode !== "direct_select") stopPulse();
  });

  // When in direct_select, check whether the click landed on a draw vertex/midpoint.
  // If not (i.e. empty map space), exit to simple_select so drag-to-pan works normally.
  // If it did land on a draw feature, just stop the pulse so the vertex can be dragged.
  map.on("mousedown", (e) => {
    if (draw.getMode() !== "direct_select") return;
    stopPulse();
    const drawFeatures = map.queryRenderedFeatures(e.point).filter(
      (f) => f.source && f.source.startsWith("mapbox-gl-draw")
    );
    if (drawFeatures.length === 0) {
      isBlurring = true;
      try {
        draw.changeMode("simple_select");
      } finally {
        isBlurring = false;
      }
    }
  });
  map.on("touchstart", () => {
    if (draw.getMode() === "direct_select") stopPulse();
  });

  let isSnapping = false;
  let isBlurring = false;
  let suppressGeometryChange = false;

  function replaceDrawFeatures(nextState) {
    suppressGeometryChange = true;
    try {
      restoreDrawFeatures(draw, nextState);
    } finally {
      suppressGeometryChange = false;
    }
  }

  ["draw.create", "draw.update", "draw.delete"].forEach((eventName) => {
    map.on(eventName, (event) => {
      if (isSnapping || isBlurring || suppressGeometryChange) return;
      if (eventName !== "draw.delete") {
        isSnapping = true;
        try {
          snapLinesToSkid(draw, event.features);
        } finally {
          isSnapping = false;
        }
      } else {
        stopPulse();
      }
      onGeometryChange(readDrawFeatures(draw));
    });
  });

  function enterGuidedDrawMode(mode) {
    stopPulse();
    if (styleLoading || !map.isStyleLoaded()) {
      pendingDrawMode = mode;
      return;
    }
    draw.changeMode(mode);
  }

  function selectOrDraw(geometryType, drawMode) {
    const feature = draw.getAll().features.find((candidate) => candidate.geometry.type === geometryType);
    if (!feature) {
      enterGuidedDrawMode(drawMode);
      return;
    }
    stopPulse();
    if (geometryType === "Polygon" || geometryType === "LineString") {
      draw.changeMode("direct_select", { featureId: feature.id });
      return;
    }
    draw.changeMode("simple_select", { featureIds: [feature.id] });
  }

  return {
    render(nextState) {
      currentState = nextState;
      currentBaseMode = normalizeBaseMapMode(currentState.baseMapMode);
      const newStyle = baseMapStyleFor(currentBaseMode);
      if (newStyle !== currentBaseStyle) {
        currentBaseStyle = newStyle;
        sentinelLoadingDone = false;
        clearTimeout(sentinelLoadingTimer);
        sentinelLoadingTimer = null;
        const activeMode = draw.getMode();
        if (activeMode.startsWith("draw_")) pendingDrawMode = activeMode;
        loadBaseStyle(newStyle);
      } else if (!styleLoading && projectLayersReady()) {
        applyBaseMapMode(map, currentBaseMode);
        if (currentBaseMode !== "sentinel-2") hideSentinelOverlay();
        renderProjectMap(map, currentState);
        syncGeoPdfOverlays(currentState);
        syncUserLayers(currentState);
      }
    },
    syncDraw(nextState) {
      currentState = nextState;
      if (!styleLoading && projectLayersReady()) {
        replaceDrawFeatures(currentState);
        renderProjectMap(map, currentState);
        syncGeoPdfOverlays(currentState);
        syncUserLayers(currentState);
      }
    },
    resetProject(nextState) {
      currentState = nextState;
      currentBaseMode = normalizeBaseMapMode(currentState.baseMapMode);
      fieldModeEditEnabled = false;
      selectedDrawFeatureIds = [];
      activeProfileSkylineId = null;
      pendingDrawMode = null;
      skylinePopup.remove();
      stopPulse();
      hideSentinelOverlay();
      map.stop();
      map.jumpTo({
        center: DEFAULT_MAP_VIEW.center,
        zoom: DEFAULT_MAP_VIEW.zoom,
        bearing: 0,
        pitch: 0
      });
      suppressGeometryChange = true;
      try {
        if (draw.getMode() !== "simple_select") draw.changeMode("simple_select");
        draw.deleteAll();
      } finally {
        suppressGeometryChange = false;
      }

      const resetStyle = baseMapStyleFor(currentBaseMode);
      if (resetStyle !== currentBaseStyle) {
        currentBaseStyle = resetStyle;
        loadBaseStyle(resetStyle);
        return;
      }
      if (!styleLoading && projectLayersReady()) {
        applyBaseMapMode(map, currentBaseMode);
        renderProjectMap(map, currentState);
        syncGeoPdfOverlays(currentState);
        syncUserLayers(currentState);
      }
    },
    flyToLayer(geojson) {
      // Compute bounding box of all coordinates in the GeoJSON and fly to it.
      const coords = [];
      const collect = (geometry) => {
        if (!geometry) return;
        if (geometry.type === "Point") {
          coords.push(geometry.coordinates);
        } else if (geometry.type === "MultiPoint" || geometry.type === "LineString") {
          coords.push(...geometry.coordinates);
        } else if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
          geometry.coordinates.forEach((ring) => coords.push(...ring));
        } else if (geometry.type === "MultiPolygon") {
          geometry.coordinates.forEach((poly) => poly.forEach((ring) => coords.push(...ring)));
        } else if (geometry.type === "GeometryCollection") {
          geometry.geometries.forEach(collect);
        }
      };
      (geojson.features ?? []).forEach((f) => collect(f.geometry));
      if (!coords.length) return;
      const bounds = new mapboxgl.LngLatBounds(coords[0], coords[0]);
      coords.slice(1).forEach((c) => bounds.extend(c));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 800 });
    },
    edit() {
      fieldModeEditEnabled = true;
      replaceDrawFeatures(currentState);
    },
    startDrawSkid() {
      fieldModeEditEnabled = true;
      enterGuidedDrawMode("draw_point");
    },
    startDrawSetting() {
      fieldModeEditEnabled = true;
      selectOrDraw("Polygon", "draw_polygon");
    },
    startDrawCorridor() {
      fieldModeEditEnabled = true;
      enterGuidedDrawMode("draw_line_string");
    },
    centerOnLocation(coordinate) {
      if (!isLngLat(coordinate)) return;
      const zoom = Math.max(map.getZoom(), 15);
      map.easeTo({ center: coordinate, zoom, duration: 800 });
    },
    setUserLocation(coordinate, accuracyM = null) {
      const source = map.getSource(SOURCE_IDS.userLocation);
      if (!source) return;
      source.setData(coordinate ? {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: { accuracyM },
          geometry: { type: "Point", coordinates: coordinate }
        }]
      } : emptyCollection());
    },
    clearUserLocation() {
      const source = map.getSource(SOURCE_IDS.userLocation);
      if (source) source.setData(emptyCollection());
    },
    blur() {
      // Exit any active draw/edit mode and clear pulse — call this before panel actions
      fieldModeEditEnabled = false;
      stopPulse();
      const mode = draw.getMode();
      if (mode !== "simple_select") {
        isBlurring = true;
        try {
          draw.changeMode("simple_select");
        } finally {
          isBlurring = false;
        }
      }
    },
    async captureImage(projectState = currentState) {
      const previousCamera = snapshotCamera(map);
      const bounds = projectBounds(projectState);
      if (bounds) {
        map.fitBounds(bounds, {
          padding: { top: 90, right: 70, bottom: 70, left: 70 },
          duration: 0,
          maxZoom: 16
        });
      }
      await waitForMapRender(map);
      try {
        return map.getCanvas().toDataURL("image/png");
      } catch {
        return null;
      } finally {
        if (previousCamera) {
          map.jumpTo(previousCamera);
          await waitForMapRender(map);
        }
      }
    }
  };

  function projectLayersReady() {
    return map.isStyleLoaded() && Boolean(map.getSource(SOURCE_IDS.results));
  }
}

function snapshotCamera(map) {
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch()
  };
}

function projectBounds(state) {
  const coordinates = [
    ...skidPoints(state),
    ...flattenCoordinates(state.settingPolygon),
    ...(state.skylines ?? []).flatMap((skyline) => skyline.coordinates ?? []),
    ...(state.geopdfOverlays ?? []).flatMap((overlay) => overlay.coordinates ?? []),
    ...(state.results ?? []).flatMap((result) => (result.samples ?? []).map((sample) => sample.coordinate).filter(Boolean))
  ].filter(isLngLat);

  if (!coordinates.length) return null;
  const bounds = new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]);
  coordinates.slice(1).forEach((coordinate) => bounds.extend(coordinate));
  return bounds;
}

function flattenCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  if (isLngLat(coordinates)) return [coordinates];
  return coordinates.flatMap(flattenCoordinates);
}

function isLngLat(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1]);
}

function skidPoints(state) {
  const skids = Array.isArray(state.skids) ? state.skids.filter(isLngLat) : [];
  if (skids.length) return skids;
  return isLngLat(state.skid) ? [state.skid] : [];
}

function waitForMapRender(map) {
  return new Promise((resolve) => {
    // Wait for the map to finish any in-progress camera movement, then grab
    // two animation frames so the GL canvas has been composited to screen.
    // We deliberately don't gate on map.loaded() or "idle" — those stall
    // indefinitely when background tiles (e.g. Sentinel-2) are still fetching.
    if (map.isMoving()) {
      map.once("moveend", () => {
        map.triggerRepaint();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    } else {
      map.triggerRepaint();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }
  });
}

function addBaseMapLayers(map, linzApiKey, sentinelInstanceId, mode = DEFAULT_BASE_MAP_MODE) {
  // Google satellite (hybrid: imagery + road labels baked in)
  if (!map.getSource(SOURCE_IDS.googleSatellite)) {
    map.addSource(SOURCE_IDS.googleSatellite, {
      type: "raster",
      tiles: [
        "https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
      ],
      tileSize: 256,
      maxzoom: 20,
      attribution: "© Google"
    });
    map.addLayer({
      id: LAYER_IDS.googleSatellite,
      type: "raster",
      source: SOURCE_IDS.googleSatellite,
      paint: {
        "raster-opacity": baseMapLayerOpacity(mode, "google-satellite"),
        "raster-opacity-transition": { duration: 250 }
      }
    });
  }

  // Sentinel-2 (Copernicus Data Space WMTS, least-cloudy mosaic of last 3 months)
  if (sentinelInstanceId && !map.getSource(SOURCE_IDS.sentinel2)) {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    map.addSource(SOURCE_IDS.sentinel2, {
      type: "raster",
      tiles: [
        `https://sh.dataspace.copernicus.eu/ogc/wmts/${sentinelInstanceId}?SERVICE=WMTS&REQUEST=GetTile&LAYER=TRUE_COLOR&TILEMATRIXSET=PopularWebMercator256&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&MAXCC=5&TIME=${from}/${today}`
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: "\u00a9 Copernicus/ESA Sentinel-2"
    });
    map.addLayer({
      id: LAYER_IDS.sentinel2,
      type: "raster",
      source: SOURCE_IDS.sentinel2,
      paint: {
        "raster-opacity": baseMapLayerOpacity(mode, "sentinel-2"),
        "raster-opacity-transition": { duration: 250 }
      }
    });
  }

  // LINZ hillshade
  if (linzApiKey && !map.getSource(SOURCE_IDS.linzHillshade)) {
    map.addSource(SOURCE_IDS.linzHillshade, {
      type: "raster",
      tiles: [`https://basemaps.linz.govt.nz/v1/tiles/hillshade/WebMercatorQuad/{z}/{x}/{y}.png?api=${linzApiKey}`],
      tileSize: 256,
      maxzoom: 21,
      attribution: "© LINZ"
    });
    // In linz-hillshade mode the LINZ tiles ARE the basemap — add below project layers at full opacity.
    // In outdoors mode the layer is hidden (opacity 0) and the Mapbox outdoors style is the basemap.
    const firstSymbolId = mode === "outdoors"
      ? map.getStyle().layers.find((l) => l.type === "symbol")?.id
      : undefined;
    map.addLayer({
      id: LAYER_IDS.linzHillshade,
      type: "raster",
      source: SOURCE_IDS.linzHillshade,
      paint: {
        "raster-opacity": baseMapLayerOpacity(mode, "linz-hillshade"),
        "raster-opacity-transition": { duration: 250 }
      }
    }, firstSymbolId);
  }
}

function applyBaseMapMode(map, mode) {
  const activeMode = normalizeBaseMapMode(mode);
  [
    [LAYER_IDS.googleSatellite, "google-satellite"],
    [LAYER_IDS.sentinel2, "sentinel-2"],
    [LAYER_IDS.linzHillshade, "linz-hillshade"]
  ].forEach(([layerId, layerMode]) => {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, "raster-opacity", baseMapLayerOpacity(activeMode, layerMode));
    }
  });
}


function restoreDrawFeatures(draw, state) {
  draw.deleteAll();
  const features = [];
  skidPoints(state).forEach((skid, index) => {
    const id = String(index + 1);
    features.push({ id: `skid-${id}`, type: "Feature", properties: { role: "skid", skidId: id }, geometry: { type: "Point", coordinates: skid } });
  });
  if (state.settingPolygon) features.push({ id: "setting", type: "Feature", properties: { role: "setting" }, geometry: { type: "Polygon", coordinates: state.settingPolygon } });
  state.skylines.forEach((skyline, index) => {
    const id = String(index + 1);
    features.push({ id: `skyline-${id}`, type: "Feature", properties: { role: "skyline", skylineId: id }, geometry: { type: "LineString", coordinates: skyline.coordinates } });
  });
  if (features.length) draw.add({ type: "FeatureCollection", features });
}

function readDrawFeatures(draw) {
  const features = draw.getAll().features;
  const points = features.filter((feature) => feature.geometry.type === "Point").map((feature) => feature.geometry.coordinates);
  const polygon = features.find((feature) => feature.geometry.type === "Polygon");
  const lines = features.filter((feature) => feature.geometry.type === "LineString");
  return {
    skid: points.at(-1) ?? null,
    skids: points,
    settingPolygon: polygon?.geometry.coordinates ?? null,
    skylines: lines.map((feature, index) => ({
      id: String(index + 1),
      coordinates: feature.geometry.coordinates
    }))
  };
}

function snapLinesToSkid(draw, changedFeatures = null) {
  const collection = draw.getAll();
  const skid = collection.features.filter((feature) => feature.geometry.type === "Point").at(-1)?.geometry.coordinates;
  if (!skid) return false;
  const changedLineIds = new Set((changedFeatures ?? [])
    .filter((feature) => feature.geometry?.type === "LineString")
    .map((feature) => feature.id));
  if (changedFeatures && !changedLineIds.size) return false;

  let changed = false;
  const snappedFeatures = collection.features.map((feature) => {
    if (feature.geometry.type !== "LineString" || feature.geometry.coordinates.length < 2) return feature;
    if (changedLineIds.size && !changedLineIds.has(feature.id)) return feature;

    let coordinates = feature.geometry.coordinates.map((coordinate) => [...coordinate]);
    const firstIndex = 0;
    const lastIndex = coordinates.length - 1;
    const snapIndex = distance(coordinates[firstIndex], skid) <= distance(coordinates[lastIndex], skid)
      ? firstIndex
      : lastIndex;

    if (!sameCoordinate(coordinates[snapIndex], skid)) {
      coordinates[snapIndex] = [...skid];
      changed = true;
    }

    if (snapIndex === lastIndex) {
      coordinates = coordinates.reverse();
      changed = true;
    }

    return {
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates
      }
    };
  });

  if (changed) {
    draw.set({ type: "FeatureCollection", features: snappedFeatures });
  }

  return changed;
}

function sameCoordinate(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const projectionX = start.x + t * dx;
  const projectionY = start.y + t * dy;
  return Math.hypot(point.x - projectionX, point.y - projectionY);
}

function addProjectLayers(map) {
  map.addSource(SOURCE_IDS.setting, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "setting-fill",
    type: "fill",
    source: SOURCE_IDS.setting,
    paint: { "fill-color": "#4f8f42", "fill-opacity": 0.22 }
  });
  // White glow behind the green outline so it reads on any basemap
  map.addLayer({
    id: "setting-outline-glow",
    type: "line",
    source: SOURCE_IDS.setting,
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.7 }
  });
  map.addLayer({
    id: "setting-outline",
    type: "line",
    source: SOURCE_IDS.setting,
    paint: { "line-color": "#1a8f3c", "line-width": 3 }
  });

  map.addSource(SOURCE_IDS.corridors, { type: "geojson", data: emptyCollection() });
  // Wide white glow — visible until results are calculated
  map.addLayer({
    id: "corridor-glow",
    type: "line",
    source: SOURCE_IDS.corridors,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-opacity": 0.55,
      "line-width": 14,
      "line-blur": 4
    }
  });
  map.addLayer({
    id: "corridor-base",
    type: "line",
    source: SOURCE_IDS.corridors,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#f8c400",
      "line-opacity": 0.95,
      "line-width": 3
    }
  });

  map.addSource(SOURCE_IDS.results, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "result-segments",
    type: "line",
    source: SOURCE_IDS.results,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 8, "line-color": ["get", "color"], "line-opacity": 0.96 }
  });

  map.addSource(SOURCE_IDS.skid, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "skid-halo",
    type: "circle",
    source: SOURCE_IDS.skid,
    paint: { "circle-radius": 14, "circle-color": "#ffffff", "circle-opacity": 0.9 }
  });
  map.addLayer({
    id: "skid-point",
    type: "circle",
    source: SOURCE_IDS.skid,
    paint: {
      "circle-radius": 8,
      "circle-color": "#111827",
      "circle-stroke-color": "#f8fafc",
      "circle-stroke-width": 3
    }
  });

  map.addSource(SOURCE_IDS.userLocation, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "user-location-halo",
    type: "circle",
    source: SOURCE_IDS.userLocation,
    paint: {
      "circle-radius": 15,
      "circle-color": "#2563eb",
      "circle-opacity": 0.2
    }
  });
  map.addLayer({
    id: "user-location-dot",
    type: "circle",
    source: SOURCE_IDS.userLocation,
    paint: {
      "circle-radius": 6,
      "circle-color": "#2563eb",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.95
    }
  });

  map.addSource(SOURCE_IDS.labels, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "skyline-labels",
    type: "symbol",
    source: SOURCE_IDS.labels,
    layout: {
      "text-field": ["get", "label"],
      "text-size": 15,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      "text-allow-overlap": true,
      "text-offset": [0, -1.2]
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2
    }
  });

  // GeoTIFF DEM footprint rectangle
  map.addSource(SOURCE_IDS.geotiffFootprint, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "geotiff-footprint-fill",
    type: "fill",
    source: SOURCE_IDS.geotiffFootprint,
    paint: { "fill-color": "#38bdf8", "fill-opacity": 0.08 }
  });
  map.addLayer({
    id: "geotiff-footprint-line",
    type: "line",
    source: SOURCE_IDS.geotiffFootprint,
    paint: {
      "line-color": "#38bdf8",
      "line-width": 2,
      "line-opacity": 0.9,
      "line-dasharray": [4, 3]
    }
  });

  // Pulsing ring rendered behind MapboxDraw's own vertex dots
  map.addSource(SOURCE_IDS.vertexPulse, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "vertex-pulse-ring",
    type: "circle",
    source: SOURCE_IDS.vertexPulse,
    paint: {
      "circle-radius": 8,
      "circle-color": "#1a8f3c",
      "circle-opacity": 0,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-stroke-opacity": 0
    }
  });
}

function renderProjectMap(map, state) {
  // GeoTIFF footprint — show when a DEM is loaded
  if (map.getSource(SOURCE_IDS.geotiffFootprint)) {
    const b = state.geotiffMeta?.boundsLngLat;
    map.getSource(SOURCE_IDS.geotiffFootprint).setData(b ? {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]]
        }
      }]
    } : emptyCollection());
  }

  if (map.getSource(SOURCE_IDS.setting)) {
    map.getSource(SOURCE_IDS.setting).setData(state.settingPolygon ? {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: state.settingPolygon } }]
    } : emptyCollection());
  }

  if (map.getSource(SOURCE_IDS.skid)) {
    map.getSource(SOURCE_IDS.skid).setData(state.skid ? {
      type: "FeatureCollection",
      features: skidPoints(state).map((skid, index) => ({
        type: "Feature",
        properties: { label: `Skid ${index + 1}` },
        geometry: { type: "Point", coordinates: skid }
      }))
    } : emptyCollection());
  }

  if (map.getSource(SOURCE_IDS.userLocation)) {
    map.getSource(SOURCE_IDS.userLocation).setData(state.userLocation ? {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: state.userLocation } }]
    } : emptyCollection());
  }

  if (map.getSource(SOURCE_IDS.corridors)) {
    map.getSource(SOURCE_IDS.corridors).setData({
      type: "FeatureCollection",
      features: state.skylines.map((skyline, index) => ({
        type: "Feature",
        properties: {
          label: skyline.id ?? skylineLabel(index),
          skylineId: skyline.id ?? skylineLabel(index)
        },
        geometry: { type: "LineString", coordinates: skyline.coordinates }
      }))
    });
  }

  // Glow fades away once results are calculated; comes back if results are cleared
  const hasResults = state.results.some((r) => r.samples?.length > 1);
  if (map.getLayer("corridor-glow")) {
    map.setPaintProperty("corridor-glow", "line-opacity", hasResults ? 0 : 0.55);
    map.setPaintProperty("corridor-base", "line-color", hasResults ? COLORS.neutral : "#f8c400");
    map.setPaintProperty("corridor-base", "line-width", hasResults ? 2 : 3);
  }

  if (map.getSource(SOURCE_IDS.results)) {
    map.getSource(SOURCE_IDS.results).setData({
      type: "FeatureCollection",
      features: state.results.flatMap((result) =>
        result.samples.slice(1).map((sample, index) => ({
          type: "Feature",
          properties: {
            color: COLORS[sample.status],
            status: sample.status,
            skylineId: result.id
          },
          geometry: {
            type: "LineString",
            coordinates: [result.samples[index].coordinate, sample.coordinate]
          }
        }))
      )
    });
  }

  const settingArea = polygonAreaSquareMetres(state.settingPolygon);
  const settingCentroid = polygonCentroid(state.settingPolygon);
  const settingLabel = settingCentroid ? [{
    type: "Feature",
    properties: {
      label: `Harvest setting\n${formatArea(settingArea)}`
    },
    geometry: { type: "Point", coordinates: settingCentroid }
  }] : [];

  if (map.getSource(SOURCE_IDS.labels)) {
    map.getSource(SOURCE_IDS.labels).setData({
      type: "FeatureCollection",
      features: [
        ...settingLabel,
        ...state.skylines.map((skyline, index) => ({
          type: "Feature",
          properties: { label: skyline.id ?? skylineLabel(index) },
          geometry: { type: "Point", coordinates: labelCoordinate(skyline.coordinates) }
        }))
      ]
    });
  }
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

function addParcelLayer(map) {
  if (map.getSource(SOURCE_IDS.linzParcels)) return;
  map.addSource(SOURCE_IDS.linzParcels, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsFill,
    type: "fill",
    source: SOURCE_IDS.linzParcels,
    minzoom: 13,
    paint: { "fill-color": "#f59e0b", "fill-opacity": 0.05 }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsLine,
    type: "line",
    source: SOURCE_IDS.linzParcels,
    minzoom: 13,
    paint: { "line-color": "#92400e", "line-width": 0.8, "line-opacity": 0.7 }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsLabel,
    type: "symbol",
    source: SOURCE_IDS.linzParcels,
    minzoom: 15,
    layout: {
      "text-field": ["get", "appellation"],
      "text-size": 10,
      "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
      "text-allow-overlap": false,
      "text-max-width": 8
    },
    paint: {
      "text-color": "#78350f",
      "text-halo-color": "rgba(255,255,255,0.8)",
      "text-halo-width": 1.5
    }
  });
}

function fetchParcels(map, ldsKey) {
  if (!ldsKey || !map.getSource(SOURCE_IDS.linzParcels)) return;
  if (map.getZoom() < 13) return;
  const bounds = map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
  const url = `https://data.linz.govt.nz/services;key=${ldsKey}/wfs`
    + `?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeNames=layer-50772&outputFormat=application/json`
    + `&bbox=${bbox},EPSG:4326`;
  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (map.getSource(SOURCE_IDS.linzParcels)) {
        map.getSource(SOURCE_IDS.linzParcels).setData(data);
      }
    })
    .catch(() => {});
}

function addTerrainSource(map) {
  if (map.getSource(TERRAIN_SOURCE_ID)) return;
  map.addSource(TERRAIN_SOURCE_ID, {
    type: "raster-dem",
    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14
  });
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });
}

function createFallbackMap(
  container,
  state,
  onGeometryChange,
  message = "Mapbox token not set. The prototype is running in no-map mode."
) {
  container.innerHTML = `
    <div class="fallback-map">
      <div class="map-legend">
        <span><i class="legend-green"></i> Clearance</span>
        <span><i class="legend-red"></i> No lift</span>
        <span><i class="legend-skid"></i> Skid</span>
      </div>
      <p>${message}</p>
      <button data-demo>Load demo geometry</button>
    </div>
  `;
  container.querySelector("[data-demo]").addEventListener("click", () => {
    onGeometryChange({
      skid: [0, 0],
      settingPolygon: [[[0, 0], [0.008, 0.002], [0.01, 0.011], [0.001, 0.012], [0, 0]]],
      skylines: [
        { id: "skyline-1", coordinates: [[0, 0], [0.006, 0.008]] },
        { id: "skyline-2", coordinates: [[0, 0], [0.009, 0.004]] }
      ]
    });
  });
  return {
    render(nextState) {
      state = nextState;
    },
    syncDraw(nextState) {
      state = nextState;
    },
    resetProject(nextState) {
      state = nextState;
    },
    centerOnLocation() {},
    edit() {},
    startDrawSkid() {},
    startDrawSetting() {},
    startDrawCorridor() {},
    async captureImage() {
      return null;
    }
  };
}

function addLegend(container) {
  const legend = document.createElement("div");
  legend.className = "map-legend";
  legend.innerHTML = `
    <span><i class="legend-green"></i> Clearance</span>
    <span><i class="legend-red"></i> Below minimum / no lift</span>
    <span><i class="legend-setting"></i> Setting</span>
    <span><i class="legend-skid"></i> Skid</span>
  `;
  container.appendChild(legend);
}

function renameDrawControls(container) {
  window.requestAnimationFrame(() => {
    const labels = [
      [".mapbox-gl-draw_point", "Add skid"],
      [".mapbox-gl-draw_line", "Draw skyline corridor"],
      [".mapbox-gl-draw_polygon", "Draw harvest setting"],
      [".mapbox-gl-draw_trash", "Delete selected layer"]
    ];

    labels.forEach(([selector, label]) => {
      const button = container.querySelector(selector);
      if (!button) return;
      button.title = label;
      button.setAttribute("aria-label", label);
    });
  });
}

function bindDrawTrashControl(container, onDeleteSelected) {
  window.requestAnimationFrame(() => {
    const button = container.querySelector(".mapbox-gl-draw_trash");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      onDeleteSelected();
    }, true);
  });
}

function skylineLabel(index) {
  return String(index + 1);
}

function labelCoordinate(coordinates) {
  if (!coordinates?.length) return [0, 0];
  const index = Math.max(0, Math.floor((coordinates.length - 1) / 2));
  const start = coordinates[index];
  const end = coordinates[index + 1] ?? start;
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function skylineIdFromFeature(feature) {
  const skylineId = feature?.properties?.skylineId ?? feature?.properties?.label;
  return skylineId == null ? null : String(skylineId);
}

function skylineProfilePopupHtml(state, skylineId) {
  const skyline = (state.skylines ?? []).find((item) => String(item.id) === skylineId);
  const result = (state.results ?? []).find((item) => String(item.id) === skylineId);

  if (!result) {
    const length = skylineLength(skyline?.coordinates ?? []);
    return `
      <section class="skyline-popup-card">
        <h4>Skyline ${escapeHtml(skylineId)}</h4>
        <p class="skyline-popup-note">Profile not calculated yet.</p>
        <dl>
          <dt>Length</dt><dd>${length.toFixed(0)} m</dd>
        </dl>
      </section>
    `;
  }

  const samples = result.samples ?? [];
  const landing = samples[0] ?? {};
  const tailhold = samples.at(-1) ?? {};
  const minSample = samples.reduce(
    (min, sample) => (sample.clearance < min.clearance ? sample : min),
    samples[0] ?? { clearance: Number.POSITIVE_INFINITY, distanceAlongLine: 0 }
  );

  return `
    <section class="skyline-popup-card">
      <h4>Skyline ${escapeHtml(result.id ?? skylineId)} profile</h4>
      ${renderSkylineProfileMiniChart(result)}
      <dl>
        <dt>Length</dt><dd>${result.length.toFixed(0)} m</dd>
        <dt>Deflection</dt><dd>${Number(result.deflectionPercent || 0).toFixed(0)}%</dd>
        <dt>Min clearance</dt><dd>${result.minClearance.toFixed(1)} m</dd>
        <dt>Min at</dt><dd>${Number(minSample.distanceAlongLine || 0).toFixed(0)} m</dd>
        <dt>Clearance</dt><dd>${result.percentGreen.toFixed(0)}%</dd>
        <dt>No lift</dt><dd>${result.percentRed.toFixed(0)}%</dd>
      </dl>
      <p class="skyline-popup-note">Landing ${formatElevation(landing.groundElevation)} m, tailhold ${formatElevation(tailhold.groundElevation)} m.</p>
    </section>
  `;
}

function renderSkylineProfileMiniChart(result) {
  const samples = result.samples ?? [];
  if (samples.length < 2) return "";

  const width = 240;
  const height = 94;
  const margin = { top: 7, right: 7, bottom: 8, left: 7 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const maxDistance = Math.max(result.length || 0, ...samples.map(sampleDistance));
  if (maxDistance <= 0) return "";

  const elevations = samples
    .flatMap((sample) => [Number(sample.groundElevation), skylineHeight(sample)])
    .filter(Number.isFinite);
  if (!elevations.length) return "";

  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const yRange = Math.max(1, maxElevation - minElevation);

  const x = (sample) => margin.left + (sampleDistance(sample) / maxDistance) * plotWidth;
  const y = (elevation) => margin.top + (1 - ((elevation - minElevation) / yRange)) * plotHeight;

  const terrainPoints = samples.map((sample) => {
    const elevation = Number.isFinite(Number(sample.groundElevation)) ? Number(sample.groundElevation) : minElevation;
    return `${x(sample).toFixed(1)},${y(elevation).toFixed(1)}`;
  }).join(" ");

  const skylinePoints = samples.map((sample) => {
    const elevation = Number.isFinite(skylineHeight(sample)) ? skylineHeight(sample) : minElevation;
    return `${x(sample).toFixed(1)},${y(elevation).toFixed(1)}`;
  }).join(" ");

  const minSample = samples.reduce(
    (min, sample) => (Number(sample.clearance) < Number(min.clearance) ? sample : min),
    samples[0]
  );
  const minElevationPoint = Number.isFinite(skylineHeight(minSample)) ? skylineHeight(minSample) : minElevation;

  return `
    <figure class="skyline-popup-chart" aria-hidden="true">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="#f8fafc" stroke="#d7ded2" />
        <polyline points="${terrainPoints}" fill="none" stroke="#2f3437" stroke-width="1.8" />
        <polyline points="${skylinePoints}" fill="none" stroke="#0f477a" stroke-width="2.4" />
        <circle cx="${x(minSample).toFixed(1)}" cy="${y(minElevationPoint).toFixed(1)}" r="2.8" fill="${result.pass ? "#178f48" : "#d71920"}" />
      </svg>
      <figcaption>Terrain + deflected skyline profile</figcaption>
    </figure>
  `;
}

function sampleDistance(sample) {
  const value = Number(sample?.distanceAlongLine ?? sample?.distanceAlong ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function skylineHeight(sample) {
  const value = Number(sample?.skylineElevation ?? sample?.cableElevation);
  return Number.isFinite(value) ? value : NaN;
}

function skylineLength(coordinates) {
  return coordinates.slice(1).reduce((total, coordinate, index) => {
    return total + distance(coordinates[index], coordinate);
  }, 0);
}

function formatElevation(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "-";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
