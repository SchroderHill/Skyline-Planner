import { formatArea, polygonAreaSquareMetres } from "./geometry.js";

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
        <aside class="panel">
          <section class="workflow">
            <h2>Workflow</h2>
            <ol id="workflowSteps"></ol>
          </section>
          <div class="actions">
            <button id="assumptions">Set assumptions</button>
            <button id="calculate">Calculate</button>
            <button id="edit">Edit corridors</button>
            <button id="print">Print report</button>
            <button id="exportGeoJson">Export GeoJSON</button>
            <button id="reset" class="danger">Reset project</button>
          </div>
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
            </div>
            <div id="userLayersList" class="user-layers-list"></div>
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
          <section>
            <h2>Skyline Summary</h2>
            <div id="results"></div>
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
    root.querySelector("#projectName").addEventListener("input", (event) => handlers.rename(event.target.value));
    root.querySelector("#assumptions").addEventListener("click", () => {
      if (!dialog.open) dialog.showModal();
    });
    root.querySelector("#saveAssumptions").addEventListener("click", () => handlers.saveAssumptions(readForm(dialog)));
    dialog.querySelector("[name=\"landingTowerPreset\"]").addEventListener("change", () => updateTowerHeightFields(dialog));
    root.querySelector("#calculate").addEventListener("click", handlers.calculate);
    root.querySelector("#edit").addEventListener("click", handlers.edit);
    root.querySelector("#print").addEventListener("click", handlers.print);
    root.querySelector("#exportGeoJson").addEventListener("click", handlers.exportGeoJson);
    root.querySelector("#reset").addEventListener("click", handlers.reset);
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
    root.querySelector("#userLayersList").addEventListener("click", (event) => {
      const toggleBtn = event.target.closest("[data-toggle-layer]");
      const removeBtn = event.target.closest("[data-remove-layer]");
      const zoomBtn = event.target.closest("[data-zoom-layer]");
      if (toggleBtn) handlers.toggleUserLayer(toggleBtn.dataset.toggleLayer);
      if (removeBtn) handlers.removeUserLayer(removeBtn.dataset.removeLayer);
      if (zoomBtn) handlers.zoomToUserLayer(zoomBtn.dataset.zoomLayer);
    });
    root.dataset.mounted = "true";
  }

  updateApp(root, state);
}

function updateApp(root, state) {
  const projectName = root.querySelector("#projectName");
  if (document.activeElement !== projectName) projectName.value = state.projectName;

  root.querySelector("#workflowSteps").innerHTML = `
    ${workflowStep("Draw skid / landing", Boolean(state.skid))}
    ${workflowStep("Draw setting boundary", Boolean(state.settingPolygon))}
    ${workflowStep("Draw skyline corridors", state.skylines.length > 0)}
    ${workflowStep("Set hauler assumptions", hasAssumptions(state.assumptions))}
    ${workflowStep(state.results.length ? "Recalculate clearance" : "Calculate clearance", state.results.length > 0)}
    ${workflowStep("Edit corridors as needed", false)}
    ${workflowStep("Print preliminary report", false)}
  `;

  root.querySelector("#calculate").textContent = state.results.length ? "Recalculate" : "Calculate";
  root.querySelectorAll(".basemap-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.baseMapMode ?? "outdoors"));
  });
  root.querySelector("#terrainMode").value = state.terrainMode;
  root.querySelector("#terrainNote").innerHTML = terrainNote(state.terrainStatus);

  const isGeoTiff = state.terrainMode === "geotiff";
  root.querySelector("#geotiffUploadSection").classList.toggle("is-hidden", !isGeoTiff);
  if (isGeoTiff) {
    root.querySelector("#geotiffMeta").innerHTML = renderGeoTiffMeta(state.geotiffMeta, state.geotiffError);
  }
  root.querySelector("#skidStatus").textContent = state.skid ? "1 point" : "Not drawn";
  root.querySelector("#settingStatus").textContent = state.settingPolygon ? "1 polygon" : "Not drawn";
  root.querySelector("#settingArea").textContent = formatArea(polygonAreaSquareMetres(state.settingPolygon));
  root.querySelector("#skylineCount").textContent = String(state.skylines.length);
  root.querySelector("#results").innerHTML = renderResults(state.results);
  root.querySelector("#userLayersList").innerHTML = renderUserLayers(state.userLayers ?? []);

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

function renderResults(results) {
  if (!results.length) return "<p class=\"muted\">No results yet.</p>";
  return `
    <table class="summary-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Len</th>
          <th>Defl</th>
          <th>Min</th>
          <th>Clear</th>
          <th>No lift</th>
        </tr>
      </thead>
      <tbody>
        ${results.map((result) => `
          <tr class="${result.pass ? "pass" : "fail"}">
            <td>${escapeHtml(result.id)}</td>
            <td>${result.length.toFixed(0)} m</td>
            <td>${Number(result.deflectionPercent || 0).toFixed(0)}%</td>
            <td>${result.minClearance.toFixed(1)} m</td>
            <td>${result.percentGreen.toFixed(0)}%</td>
            <td>${result.percentRed.toFixed(0)}%</td>
          </tr>
          ${result.pass ? "" : `<tr class="warning-row"><td colspan="6">Warning: section below minimum clearance.</td></tr>`}
        `).join("")}
      </tbody>
    </table>
  `;
}

function workflowStep(label, complete) {
  return `<li class="${complete ? "complete" : ""}"><span>${complete ? "OK" : ""}</span>${escapeHtml(label)}</li>`;
}

function hasAssumptions(assumptions) {
  return Boolean(assumptions.haulerName || assumptions.landingTowerHeight);
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

function renderUserLayers(layers) {
  if (!layers.length) {
    return `<p class="muted user-layers-empty">No files imported yet.</p>`;
  }
  return layers.map((layer) => `
    <div class="user-layer-item">
      <span class="user-layer-swatch" style="background:${escapeHtml(layer.color)};"></span>
      <span class="user-layer-name" title="${escapeHtml(layer.name)}">${escapeHtml(layer.name)}</span>
      <button class="user-layer-btn" data-zoom-layer="${escapeHtml(layer.id)}" title="Zoom to layer">⌖</button>
      <button class="user-layer-btn${layer.visible ? "" : " user-layer-btn--muted"}" data-toggle-layer="${escapeHtml(layer.id)}" title="${layer.visible ? "Hide layer" : "Show layer"}">${layer.visible ? "👁" : "👁"}</button>
      <button class="user-layer-btn user-layer-btn--danger" data-remove-layer="${escapeHtml(layer.id)}" title="Remove layer">✕</button>
    </div>
  `).join("");
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
