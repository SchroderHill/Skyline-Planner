import { formatArea, polygonAreaSquareMetres } from "./geometry.js";
import { DEFAULT_ASSUMPTIONS } from "./clearance.js";

export function renderApp(root, state, handlers) {
  if (!root.dataset.mounted) {
    root.innerHTML = `
      <header class="topbar">
        <div>
          <h1>Skyline Planning Report</h1>
          <p>by Schroder Hill Limited</p>
        </div>
        <label class="project-name-field">
          <span>Project name</span>
          <input id="projectName" aria-label="Project name" placeholder="Enter project name here" />
        </label>
      </header>
      <main class="layout">
        <section class="map-pane">
          <div id="map"></div>
        </section>
        <aside class="panel">
          <section class="workflow workflow--guided">
            <div class="workflow-head">
              <h2>Guided Workflow</h2>
              <p id="workflowHint" class="workflow-hint"></p>
              <button id="workflowPrimaryAction" class="workflow-primary-action" type="button"></button>
              <div id="fieldModeToolbar" class="field-mode-toolbar">
                <button id="toggleAdvancedTools" class="field-mode-btn" type="button">More tools</button>
                <button id="toggleLocationTracking" class="field-mode-btn" type="button">Start location</button>
              </div>
              <p id="locationStatus" class="location-status" role="status" aria-live="polite"></p>
            </div>
            <ol id="workflowSteps" class="workflow-steps"></ol>
          </section>
          <div class="workflow-ghost-controls" aria-hidden="true">
            <button id="assumptions" type="button">Set assumptions</button>
            <button id="calculate" type="button">Calculate</button>
          </div>
          <section class="actions-panel">
            <h2>Project Actions</h2>
            <div class="actions">
              <button id="assumptionsAction" type="button">Set assumptions</button>
              <button id="drawOptionalArea" type="button">Draw optional area</button>
              <button id="edit">Edit corridors</button>
              <button id="print">Print report</button>
              <button id="exportGeoJson">Export GeoJSON</button>
              <button id="reset" class="danger">Reset project</button>
            </div>
          </section>
          <section class="basemap-section">
            <h2>Basemap</h2>
            <div class="basemap-picker" id="basemapPicker">
              <button class="basemap-btn" data-mode="outdoors" title="Mapbox outdoors">
                <span class="basemap-thumb basemap-thumb--outdoors"></span>
                <span>Outdoors</span>
              </button>
              <button class="basemap-btn" data-mode="linz-hillshade" title="LINZ hillshade">
                <span class="basemap-thumb basemap-thumb--hillshade"></span>
                <span>Hillshade</span>
              </button>
              <button class="basemap-btn" data-mode="google-satellite" title="Google satellite">
                <span class="basemap-thumb basemap-thumb--satellite"></span>
                <span>Satellite</span>
              </button>
              <button class="basemap-btn" data-mode="sentinel-2" title="Sentinel-2 &lt;5% cloud">
                <span class="basemap-thumb basemap-thumb--sentinel"></span>
                <span>Sentinel-2</span>
              </button>
            </div>
          </section>
          <section class="terrain-panel">
            <h2>Terrain</h2>
            <label>
              Source
              <select id="terrainMode">
                <option value="mapbox">Mapbox terrain</option>
                <option value="geotiff">Uploaded GeoTIFF DEM</option>
                <option value="mock">Mock terrain</option>
              </select>
            </label>
            <div id="geotiffUploadSection" class="geotiff-upload is-hidden">
              <label class="geotiff-file-label">
                Upload DEM (.tif / .tiff)
                <input id="geotiffFile" type="file" accept=".tif,.tiff" />
              </label>
              <div id="geotiffMeta" class="geotiff-meta"></div>
            </div>
            <p id="terrainNote" class="terrain-note"></p>
          </section>
          <section class="user-data-panel">
            <h2>User Data</h2>
            <div class="user-data-imports">
              <label class="user-data-file-label">
                Import KML
                <input id="kmlFile" type="file" accept=".kml" />
              </label>
              <label class="user-data-file-label">
                Import Shapefile (.zip)
                <input id="shapeFile" type="file" accept=".zip" />
              </label>
              <label class="user-data-file-label">
                Import GeoPDF
                <input id="geoPdfFile" type="file" accept=".pdf,application/pdf" />
              </label>
            </div>
            <div id="userLayersList" class="user-layers-list"></div>
            <div id="geoPdfStatus" class="geopdf-status"></div>
            <div id="geoPdfOverlaysList" class="user-layers-list"></div>
          </section>
          <section>
            <h2>Inputs</h2>
            <dl>
              <dt>Skid</dt><dd id="skidStatus">Not drawn</dd>
              <dt>Setting</dt><dd id="settingStatus">Not drawn</dd>
              <dt>Setting area</dt><dd id="settingArea">Not drawn</dd>
              <dt>Skylines</dt><dd id="skylineCount">0</dd>
            </dl>
          </section>
        </aside>
      </main>
      <dialog id="assumptionsDialog">
        <form method="dialog" class="modal-form">
          <h2>Assumptions</h2>
          ${field("Hauler name", "haulerName")}
          <label>Landing tower height
            <select name="landingTowerPreset">
              ${towerHeightOptions()}
            </select>
          </label>
          <label class="custom-tower-height">Custom tower height (m)
            <input name="landingTowerHeight" type="number" step="0.1" />
          </label>
          ${field("Tailhold height (m)", "tailholdHeight", "number")}
          ${field("Minimum required clearance (m)", "minimumClearance", "number")}
          ${field("Manual sag allowance (m)", "manualSagAllowance", "number")}
          <label>Deflection (%)
            <select name="deflectionPercent">
              ${[0, 2, 4, 5, 6, 8, 10, 12].map((value) => `<option value="${value}">${value}%</option>`).join("")}
            </select>
            <small>User-defined geometric deflection. This prototype does not calculate true rope tension, safe working load, or cable mechanics.</small>
          </label>
          ${field("Sample spacing (m)", "sampleSpacing", "number")}
          <div class="modal-actions">
            <button value="cancel">Cancel</button>
            <button id="saveAssumptions" value="default">Save</button>
          </div>
        </form>
      </dialog>
    `;

    const dialog = root.querySelector("#assumptionsDialog");
    const openAssumptions = () => {
      if (!dialog.open) dialog.showModal();
    };
    const runWorkflowAction = (action) => {
      if (action === "draw-skid") handlers.startDrawSkid();
      if (action === "draw-setting") handlers.startDrawSetting();
      if (action === "draw-corridor") handlers.startDrawCorridor();
      if (action === "open-assumptions") openAssumptions();
      if (action === "calculate") handlers.calculate();
    };

    root.querySelector("#projectName").addEventListener("input", (event) => handlers.rename(event.target.value));
    root.querySelector("#assumptions").addEventListener("click", openAssumptions);
    root.querySelector("#assumptionsAction").addEventListener("click", openAssumptions);
    root.querySelector("#saveAssumptions").addEventListener("click", () => handlers.saveAssumptions(readForm(dialog)));
    dialog.querySelector("[name=\"landingTowerPreset\"]").addEventListener("change", () => updateTowerHeightFields(dialog));
    root.querySelector("#calculate").addEventListener("click", handlers.calculate);
    root.querySelector("#drawOptionalArea").addEventListener("click", handlers.startDrawSetting);
    root.querySelector("#edit").addEventListener("click", handlers.edit);
    root.querySelector("#print").addEventListener("click", handlers.print);
    root.querySelector("#exportGeoJson").addEventListener("click", handlers.exportGeoJson);
    root.querySelector("#reset").addEventListener("click", handlers.reset);
    root.querySelector("#workflowSteps").addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-workflow-action]");
      if (!actionButton || actionButton.disabled) return;
      runWorkflowAction(actionButton.dataset.workflowAction);
    });
    root.querySelector("#workflowPrimaryAction").addEventListener("click", (event) => {
      if (event.currentTarget.disabled) return;
      runWorkflowAction(event.currentTarget.dataset.workflowAction);
    });
    root.querySelector("#toggleAdvancedTools").addEventListener("click", handlers.toggleAdvancedTools);
    root.querySelector("#toggleLocationTracking").addEventListener("click", handlers.toggleLocationTracking);
    root.querySelector("#basemapPicker").addEventListener("click", (event) => {
      const btn = event.target.closest(".basemap-btn");
      if (btn) handlers.changeBaseMapMode(btn.dataset.mode);
    });
    root.querySelector("#terrainMode").addEventListener("change", (event) => {
      handlers.changeTerrainMode(event.target.value);
    });
    root.querySelector("#geotiffFile").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) handlers.loadGeoTiff(file);
    });
    root.querySelector("#kmlFile").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) { handlers.loadKml(file); event.target.value = ""; }
    });
    root.querySelector("#shapeFile").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) { handlers.loadShapefile(file); event.target.value = ""; }
    });
    root.querySelector("#geoPdfFile").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) { handlers.loadGeoPdf(file); event.target.value = ""; }
    });
    root.querySelector("#userLayersList").addEventListener("click", (event) => {
      const toggleBtn = event.target.closest("[data-toggle-layer]");
      const removeBtn = event.target.closest("[data-remove-layer]");
      const zoomBtn = event.target.closest("[data-zoom-layer]");
      if (toggleBtn) handlers.toggleUserLayer(toggleBtn.dataset.toggleLayer);
      if (removeBtn) handlers.removeUserLayer(removeBtn.dataset.removeLayer);
      if (zoomBtn) handlers.zoomToUserLayer(zoomBtn.dataset.zoomLayer);
    });
    root.querySelector("#geoPdfOverlaysList").addEventListener("click", (event) => {
      const toggleBtn = event.target.closest("[data-toggle-geopdf]");
      const removeBtn = event.target.closest("[data-remove-geopdf]");
      const zoomBtn = event.target.closest("[data-zoom-geopdf]");
      if (toggleBtn) handlers.toggleGeoPdfOverlay(toggleBtn.dataset.toggleGeopdf);
      if (removeBtn) handlers.removeGeoPdfOverlay(removeBtn.dataset.removeGeopdf);
      if (zoomBtn) handlers.zoomToGeoPdfOverlay(zoomBtn.dataset.zoomGeopdf);
    });
    root.querySelector("#geoPdfOverlaysList").addEventListener("input", (event) => {
      const input = event.target.closest("[data-geopdf-opacity]");
      if (!input) return;
      handlers.setGeoPdfOverlayOpacity(input.dataset.geopdfOpacity, Number(input.value));
    });

    // In iframe embeds, relocate the project name field into the sidebar to maximize map height.
    if (document.documentElement.classList.contains("is-embedded")) {
      const projectNameField = root.querySelector(".project-name-field");
      const panel = root.querySelector(".panel");
      if (projectNameField && panel) {
        projectNameField.classList.add("project-name-field--in-panel");
        panel.prepend(projectNameField);
      }
    }

    root.dataset.mounted = "true";
  }

  updateApp(root, state);
}

function updateApp(root, state) {
  const isFieldMode = Boolean(state.isFieldMode);
  const showAdvancedTools = Boolean(state.showAdvancedTools);
  root.classList.toggle("is-field-mode", isFieldMode);
  root.classList.toggle("show-advanced-tools", showAdvancedTools);

  const toggleAdvancedTools = root.querySelector("#toggleAdvancedTools");
  toggleAdvancedTools.textContent = showAdvancedTools ? "Hide tools" : "More tools";
  toggleAdvancedTools.setAttribute("aria-pressed", String(showAdvancedTools));

  const toggleLocationTracking = root.querySelector("#toggleLocationTracking");
  toggleLocationTracking.textContent = state.locationTracking ? "Stop location" : "Start location";
  toggleLocationTracking.setAttribute("aria-pressed", String(Boolean(state.locationTracking)));
  toggleLocationTracking.disabled = state.locationErrorKind === "unsupported";

  const locationStatus = root.querySelector("#locationStatus");
  locationStatus.textContent = state.locationStatus ?? "";
  locationStatus.classList.toggle("location-status--error", Boolean(state.locationErrorKind));
  locationStatus.classList.toggle("location-status--active", Boolean(state.locationTracking && state.userLocation));

  const projectName = root.querySelector("#projectName");
  if (document.activeElement !== projectName) projectName.value = state.projectName;

  const workflow = workflowModel(state);
  root.querySelector("#workflowHint").textContent = workflow.hint;
  root.querySelector("#workflowSteps").innerHTML = renderWorkflowSteps(workflow.steps);
  const workflowPrimaryAction = root.querySelector("#workflowPrimaryAction");
  workflowPrimaryAction.textContent = workflow.primaryAction.actionLabel;
  workflowPrimaryAction.dataset.workflowAction = workflow.primaryAction.action;
  workflowPrimaryAction.disabled = !workflow.primaryAction.enabled;
  workflowPrimaryAction.classList.toggle("is-loading", Boolean(state.isCalculating));
  workflowPrimaryAction.setAttribute("aria-busy", String(Boolean(state.isCalculating)));

  root.querySelector("#calculate").textContent = state.isCalculating ? "Calculating..." : state.results.length ? "Recalculate" : "Calculate";
  root.querySelector("#calculate").disabled = state.isCalculating || !workflow.canCalculate;
  const skidCount = skidPoints(state).length;
  root.querySelector("#drawOptionalArea").disabled = !skidCount;
  root.querySelector("#edit").disabled = !state.skylines.length;
  const hasProjectData = Boolean(skidCount || state.settingPolygon || state.skylines.length || state.results.length);
  root.querySelector("#print").disabled = !hasProjectData;
  root.querySelector("#exportGeoJson").disabled = !hasProjectData;
  root.querySelectorAll(".basemap-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.baseMapMode ?? "google-satellite"));
  });
  root.querySelector("#terrainMode").value = state.terrainMode;
  root.querySelector("#terrainNote").innerHTML = terrainNote(state.terrainStatus);

  const isGeoTiff = state.terrainMode === "geotiff";
  root.querySelector("#geotiffUploadSection").classList.toggle("is-hidden", !isGeoTiff);
  if (isGeoTiff) {
    root.querySelector("#geotiffMeta").innerHTML = renderGeoTiffMeta(state.geotiffMeta, state.geotiffError);
  }
  root.querySelector("#skidStatus").textContent = skidCount ? `${skidCount} point${skidCount === 1 ? "" : "s"}` : "Not drawn";
  root.querySelector("#settingStatus").textContent = state.settingPolygon ? "1 polygon" : "Not drawn";
  root.querySelector("#settingArea").textContent = formatArea(polygonAreaSquareMetres(state.settingPolygon));
  root.querySelector("#skylineCount").textContent = String(state.skylines.length);
  root.querySelector("#userLayersList").innerHTML = renderUserLayers(state.userLayers ?? []);
  root.querySelector("#geoPdfStatus").innerHTML = renderGeoPdfStatus(state.geopdfImport);
  root.querySelector("#geoPdfOverlaysList").innerHTML = renderGeoPdfOverlays(state.geopdfOverlays ?? []);

  const dialog = root.querySelector("#assumptionsDialog");
  if (!dialog.open) {
    Object.entries(state.assumptions).forEach(([name, value]) => {
      const input = dialog.querySelector(`[name="${name}"]`);
      if (input) input.value = value ?? "";
    });
    const preset = dialog.querySelector("[name=\"landingTowerPreset\"]");
    preset.value = state.assumptions.landingTowerPreset ?? towerPresetForMetres(state.assumptions.landingTowerHeight);
    updateTowerHeightFields(dialog);
  }
}

function terrainNote(status) {
  const warning = status?.warning ? `<strong>${escapeHtml(status.warning)}</strong>` : "";
  return `${escapeHtml(status?.source ?? "Terrain source: unknown")}${warning ? `<br>${warning}` : ""}`;
}

function field(label, name, type = "text") {
  return `<label>${label}<input name="${name}" type="${type}" step="0.1" /></label>`;
}

function readForm(dialog) {
  return Object.fromEntries(new FormData(dialog.querySelector("form")).entries());
}

function towerHeightOptions() {
  return [35, 50, 60, 70, 90]
    .map((feet) => `<option value="${feet}">${feet} ft</option>`)
    .join("") + "<option value=\"custom\">Custom</option>";
}

function updateTowerHeightFields(dialog) {
  const preset = dialog.querySelector("[name=\"landingTowerPreset\"]");
  const customField = dialog.querySelector(".custom-tower-height");
  const customInput = customField.querySelector("input");
  const isCustom = preset.value === "custom";
  customField.classList.toggle("is-hidden", !isCustom);
  customInput.disabled = !isCustom;
}

function towerPresetForMetres(metres) {
  const towerFeet = [35, 50, 60, 70, 90];
  const match = towerFeet.find((feet) => Math.abs(Number(metres) - feet * 0.3048) < 0.05);
  return match ? String(match) : "custom";
}

function renderWorkflowSteps(steps) {
  return steps.map((step, index) => `
    <li class="workflow-step${step.complete ? " complete" : ""}${step.current ? " current" : ""}${step.enabled ? "" : " blocked"}">
      <span class="workflow-step__marker">${step.complete ? "OK" : String(index + 1)}</span>
      <div class="workflow-step__body">
        <h3>${escapeHtml(step.label)}</h3>
        <p>${escapeHtml(step.detail)}</p>
        <button class="workflow-step__action" data-workflow-action="${escapeHtml(step.action)}" ${step.enabled ? "" : "disabled"}>${escapeHtml(step.actionLabel)}</button>
      </div>
    </li>
  `).join("");
}

function hasAssumptions(assumptions) {
  if (!assumptions) return false;
  if (String(assumptions.haulerName ?? "").trim()) return true;
  return Object.keys(DEFAULT_ASSUMPTIONS).some((key) => assumptionChangedFromDefault(assumptions[key], DEFAULT_ASSUMPTIONS[key]));
}

function assumptionChangedFromDefault(value, baseline) {
  const n1 = Number(value);
  const n2 = Number(baseline);
  if (Number.isFinite(n1) && Number.isFinite(n2)) {
    return Math.abs(n1 - n2) > 1e-6;
  }
  return String(value ?? "") !== String(baseline ?? "");
}

function workflowModel(state) {
  const skidCount = skidPoints(state).length;
  const hasSkid = skidCount > 0;
  const hasCorridors = (state.skylines ?? []).length > 0;
  const hasResults = (state.results ?? []).length > 0;
  const isCalculating = Boolean(state.isCalculating);
  const canCalculate = hasCorridors && !isCalculating;

  const steps = [
    {
      label: "Place skid / landing",
      detail: hasSkid ? `${skidCount} landing point${skidCount === 1 ? " is" : "s are"} set on map.` : "Start by placing the skid point.",
      complete: hasSkid,
      enabled: true,
      action: "draw-skid",
      actionLabel: hasSkid ? "Add another skid" : "Start"
    },
    {
      label: "Draw skyline corridors",
      detail: hasCorridors ? `${state.skylines.length} corridor${state.skylines.length === 1 ? "" : "s"} prepared.` : "Add at least one skyline corridor.",
      complete: hasCorridors,
      enabled: hasSkid,
      action: "draw-corridor",
      actionLabel: hasCorridors ? "Add / edit corridors" : "Draw corridor"
    },
    {
      label: hasResults ? "Recalculate and review" : "Calculate clearance",
      detail: isCalculating ? "Running clearance calculation..." : hasResults ? "Results are ready." : "Run clearance using the saved or default assumptions.",
      complete: hasResults && !isCalculating,
      enabled: canCalculate,
      action: "calculate",
      actionLabel: isCalculating ? "Calculating..." : hasResults ? "Recalculate" : "Calculate"
    }
  ];

  const currentIndex = steps.findIndex((step) => !step.complete);
  if (currentIndex >= 0) steps[currentIndex].current = true;

  let hint = "Use the steps in order to complete a full planning run.";
  if (isCalculating) hint = "Calculating skyline clearance...";
  else if (!hasSkid) hint = "Step 1: Place the skid / landing point on the map.";
  else if (!hasCorridors) hint = "Step 2: Draw one or more skyline corridors from skid to tailhold.";
  else if (!hasResults) hint = "Step 3: Run Calculate to evaluate clearances.";
  else hint = "Clearance results are ready. Use project actions to refine, export, or print.";

  const primaryActionStep = hasResults
    ? steps.at(-1)
    : steps.find((step) => step.current)
    ?? steps.find((step) => !step.complete && step.enabled)
    ?? steps.find((step) => step.enabled)
    ?? steps[0];

  return {
    steps,
    hint,
    canCalculate,
    primaryAction: {
      action: primaryActionStep.action,
      actionLabel: primaryActionStep.actionLabel,
      enabled: Boolean(primaryActionStep.enabled)
    }
  };
}

function skidPoints(state) {
  const skids = Array.isArray(state.skids) ? state.skids.filter(isLngLat) : [];
  if (skids.length) return skids;
  return isLngLat(state.skid) ? [state.skid] : [];
}

function isLngLat(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1]);
}

function renderGeoTiffMeta(meta, error) {
  if (error) {
    return `<p class="geotiff-error">${escapeHtml(error)}</p>`;
  }
  if (!meta) {
    return `<p class="muted">No DEM loaded yet.</p>`;
  }
  const { crsLabel, width, height, resolutionM, filename, bounds } = meta;
  const fmt = (n) => n.toFixed(1);
  return `
    <dl class="geotiff-meta-dl">
      <dt>File</dt><dd>${escapeHtml(filename)}</dd>
      <dt>CRS</dt><dd>${escapeHtml(crsLabel)}</dd>
      <dt>Size</dt><dd>${width} × ${height} px</dd>
      <dt>Resolution</dt><dd>~${resolutionM} m</dd>
      <dt>Extent</dt><dd>${fmt(bounds.minX)}, ${fmt(bounds.minY)} → ${fmt(bounds.maxX)}, ${fmt(bounds.maxY)}</dd>
    </dl>
  `;
}

function renderGeoPdfStatus(status) {
  if (status?.loading) {
    return `<p class="muted">Importing GeoPDF&hellip;</p>`;
  }
  if (status?.error) {
    return `<p class="geopdf-error">${escapeHtml(status.error)}</p>`;
  }
  if (status?.message) {
    return `<p class="muted geopdf-message">${escapeHtml(status.message)}</p>`;
  }
  return "";
}

function renderUserLayers(layers) {
  if (!layers.length) {
    return `<p class="muted user-layers-empty">No files imported yet.</p>`;
  }
  return layers.map((layer) => `
    <div class="user-layer-item">
      <span class="user-layer-swatch" style="background:${escapeHtml(layer.color)};"></span>
      <span class="user-layer-name" title="${escapeHtml(layer.name)}">${escapeHtml(layer.name)}</span>
      <button class="user-layer-btn" data-zoom-layer="${escapeHtml(layer.id)}" title="Zoom to layer">Zoom</button>
      <button class="user-layer-btn${layer.visible ? "" : " user-layer-btn--muted"}" data-toggle-layer="${escapeHtml(layer.id)}" title="${layer.visible ? "Hide layer" : "Show layer"}">${layer.visible ? "Hide" : "Show"}</button>
      <button class="user-layer-btn user-layer-btn--danger" data-remove-layer="${escapeHtml(layer.id)}" title="Remove layer">Remove</button>
    </div>
  `).join("");
}

function renderGeoPdfOverlays(overlays) {
  if (!overlays.length) {
    return `<p class="muted user-layers-empty">No GeoPDF overlays yet.</p>`;
  }
  return overlays.map((overlay) => {
    const opacity = Number.isFinite(Number(overlay.opacity)) ? Number(overlay.opacity) : 0.65;
    const dims = overlay.width && overlay.height ? `${overlay.width}×${overlay.height}px` : "";
    const crs = overlay.crsLabel ? ` ${overlay.crsLabel}` : "";
    const rmse = Number.isFinite(Number(overlay.transformRmse)) ? Number(overlay.transformRmse) : null;
    const rmseText = rmse == null ? "" : ` Fit ${rmse.toFixed(3)}°`;
    const lowConfidenceClass = rmse != null && rmse > 0.35 ? " geopdf-meta--warn" : "";
    return `
      <div class="geopdf-layer-item">
        <div class="user-layer-item">
          <span class="user-layer-swatch geopdf-layer-swatch"></span>
          <span class="user-layer-name" title="${escapeHtml(overlay.name)}">${escapeHtml(overlay.name)}</span>
          <button class="user-layer-btn" data-zoom-geopdf="${escapeHtml(overlay.id)}" title="Zoom to overlay">Zoom</button>
          <button class="user-layer-btn${overlay.visible ? "" : " user-layer-btn--muted"}" data-toggle-geopdf="${escapeHtml(overlay.id)}" title="${overlay.visible ? "Hide overlay" : "Show overlay"}">${overlay.visible ? "Hide" : "Show"}</button>
          <button class="user-layer-btn user-layer-btn--danger" data-remove-geopdf="${escapeHtml(overlay.id)}" title="Remove overlay">Remove</button>
        </div>
        <label class="geopdf-opacity-row">
          <span>Opacity</span>
          <input type="range" min="0" max="1" step="0.05" value="${opacity.toFixed(2)}" data-geopdf-opacity="${escapeHtml(overlay.id)}" />
          <strong>${Math.round(opacity * 100)}%</strong>
        </label>
        <p class="geopdf-meta${lowConfidenceClass}">${escapeHtml(dims)}${escapeHtml(crs)}${escapeHtml(rmseText)}</p>
      </div>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
