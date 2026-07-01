import { formatArea, polygonAreaSquareMetres } from "./geometry.js";

const REPORT_ROOT_ID = "report-root";

export function printReport(state, options = {}) {
  let root = document.querySelector(`#${REPORT_ROOT_ID}`);
  if (!root) {
    root = document.createElement("div");
    root.id = REPORT_ROOT_ID;
    document.body.appendChild(root);
  }

  root.innerHTML = reportMarkup(state, options);
  document.body.classList.add("report-open");
  root.querySelector("[data-report-close]").addEventListener("click", closeReport);
  root.querySelector("[data-report-print]").addEventListener("click", () => window.print());
}

function closeReport() {
  document.body.classList.remove("report-open");
  document.querySelector(`#${REPORT_ROOT_ID}`)?.remove();
}

function reportMarkup(state, options = {}) {
  return `
    <div class="report-backdrop">
      <main class="report-page" role="dialog" aria-label="Printable report">
        <div class="report-toolbar">
          <button type="button" data-report-print>Print / Save as PDF</button>
          <button type="button" class="secondary" data-report-close>Close</button>
        </div>

        <header class="report-header">
          <div>
              <h1>Skyline Calculator</h1>
            <p>by Schroder Hill Limited</p>
          </div>
        </header>

        <section class="report-meta-grid">
          ${metaCell("Project name", state.projectName || "Not set")}
          ${metaCell("Date", new Date().toLocaleDateString())}
          ${metaCell("Terrain source used", terrainSource(state))}
          ${metaCell("Harvest setting area", formatArea(polygonAreaSquareMetres(state.settingPolygon)))}
          ${metaCell("Report type", "Browser print / Save as PDF")}
        </section>

        <h2>Assumptions</h2>
        ${table([
          ["Assumption", "Value"],
          ["Hauler name", state.assumptions.haulerName || "Not set"],
          ["Landing tower height", metres(state.assumptions.landingTowerHeight)],
          ["Tailhold height", metres(state.assumptions.tailholdHeight)],
          ["Minimum required clearance", metres(state.assumptions.minimumClearance)],
          ["Manual sag allowance", metres(state.assumptions.manualSagAllowance)],
          ["Deflection", `${state.assumptions.deflectionPercent ?? 6}%`],
          ["Sample spacing", `${state.assumptions.sampleSpacing} m`]
        ])}

        <h2>Map / Result View</h2>
        <section class="report-map-view" aria-label="Map result view">
          <div class="report-legend">
            <span><i class="report-line report-green"></i> Green = clearance</span>
            <span><i class="report-line report-red"></i> Red = below clearance / no lift</span>
          </div>
          ${renderMapImage(options.mapImage)}
        </section>

        <h2>Skyline Summary</h2>
        ${table([
          ["Skyline", "Length", "Deflection", "Minimum clearance", "Clearance", "Below clearance / no lift", "Warning"],
          ...state.results.map((result) => [
            result.id,
            `${result.length.toFixed(0)} m`,
            `${Number(result.deflectionPercent || 0).toFixed(0)}%`,
            `${result.minClearance.toFixed(1)} m`,
            `${result.percentGreen.toFixed(0)}%`,
            `${result.percentRed.toFixed(0)}%`,
            result.pass ? "" : "Section below minimum clearance"
          ])
        ])}

        <h2>Skyline Profiles</h2>
        ${renderProfileCharts(state.results)}

        <h2>Calculation Notes</h2>
        <ul class="report-notes">
          <li>Straight chord/tight line is shown for reference.</li>
          <li>Red/green clearance is calculated from the deflected skyline curve.</li>
          <li>Deflection is user-defined geometric deflection.</li>
          <li>This prototype does not calculate true rope tension, safe working load, or cable mechanics.</li>
          <li>This is preliminary screening only.</li>
        </ul>

        <p class="report-disclaimer">Preliminary skyline clearance screening only. Not a final cable harvesting plan. Final setup must be confirmed by a competent cable harvesting operator or planner.</p>
      </main>
    </div>
  `;
}

function table(rows) {
  const [head, ...body] = rows;
  if (!body.length) return "<p>No results calculated.</p>";
  return `<table class="report-table"><thead><tr>${head.map(cell).join("")}</tr></thead><tbody>${body.map((row) => `<tr class="${row.includes("Section below minimum clearance") ? "report-fail" : ""}">${row.map(cell).join("")}</tr>`).join("")}</tbody></table>`;
}

function cell(value) {
  return `<td>${escapeHtml(value)}</td>`;
}

function metaCell(label, value) {
  return `<div class="report-meta-cell"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`;
}

function terrainSource(state) {
  return state.terrainStatus?.source?.replace("Terrain source: ", "") || state.terrainMode || "Not set";
}

function metres(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} m` : "Not set";
}

function renderMapImage(mapImage) {
  if (!mapImage) {
    return `
      <div class="report-map-fallback">
        <strong>Map canvas image could not be captured.</strong>
        <span>Keep the app open and try Print report again after the map has finished rendering.</span>
      </div>
    `;
  }
  return `<img class="report-map-image" src="${mapImage}" alt="Map canvas showing skyline clearance result segments" />`;
}

function renderCorridorStrips(results) {
  if (!results.length) return "<p>No clearance results calculated.</p>";
  return results.map((result) => `
    <div class="report-corridor-row">
      <strong>${escapeHtml(result.id)}</strong>
      <div class="report-corridor-strip">${segmentBlocks(result)}</div>
      <span>${result.pass ? "Pass" : "Fail"}</span>
    </div>
  `).join("");
}

function segmentBlocks(result) {
  const segments = result.samples.slice(1);
  if (!segments.length) return "";
  const totalLength = Math.max(1, result.length || segments.at(-1)?.distanceAlongLine || segments.length);
  return segments.map((sample, index) => {
    const previous = result.samples[index];
    const start = previous?.distanceAlongLine ?? previous?.distanceAlong ?? index;
    const end = sample.distanceAlongLine ?? sample.distanceAlong ?? index + 1;
    const width = Math.max(0.4, ((end - start) / totalLength) * 100);
    return `<i class="${sample.status === "green" ? "report-green" : "report-red"}" style="width:${width.toFixed(3)}%"></i>`;
  }).join("");
}

function renderProfileCharts(results) {
  if (!results.length) return "<p>No clearance profiles calculated.</p>";
  return results.map(renderProfileChart).join("");
}

function renderProfileChart(result) {
  const samples = result.samples ?? [];
  if (samples.length < 2) {
    return `<section class="profile-card"><h3>Skyline ${escapeHtml(result.id)}</h3><p>No profile samples available.</p></section>`;
  }

  const width = 760;
  const height = 230;
  const margin = { top: 18, right: 20, bottom: 42, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxDistance = Math.max(...samples.map((sample) => sample.distanceAlongLine ?? sample.distanceAlong ?? 0), result.length || 0);
  const elevations = samples.flatMap((sample) => [sample.groundElevation, sample.chordElevation, sample.skylineElevation ?? sample.cableElevation]).filter(Number.isFinite);
  const minElevation = Math.floor((Math.min(...elevations) - 10) / 10) * 10;
  const maxElevation = Math.ceil((Math.max(...elevations) + 10) / 10) * 10;
  const yRange = Math.max(1, maxElevation - minElevation);

  const xDistance = (distance) => margin.left + (distance / Math.max(1, maxDistance)) * plotWidth;
  const x = (sample) => xDistance(sample.distanceAlongLine ?? sample.distanceAlong ?? 0);
  const y = (elevation) => margin.top + (1 - (elevation - minElevation) / yRange) * plotHeight;
  const terrainPoints = samples.map((sample) => `${x(sample).toFixed(1)},${y(sample.groundElevation).toFixed(1)}`).join(" ");
  const chordPoints = samples.map((sample) => `${x(sample).toFixed(1)},${y(sample.chordElevation ?? sample.cableElevation).toFixed(1)}`).join(" ");
  const skylinePoints = samples.map((sample) => `${x(sample).toFixed(1)},${y(sample.skylineElevation ?? sample.cableElevation).toFixed(1)}`).join(" ");
  const ticks = buildTicks(minElevation, maxElevation, 4);
  const distanceTicks = buildDistanceTicks(maxDistance);
  const landing = samples[0];
  const tailhold = samples.at(-1);

  return `
    <section class="profile-card">
      <h3>Skyline ${escapeHtml(result.id)} profile</h3>
      <svg class="profile-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Skyline ${escapeHtml(result.id)} terrain profile">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
        ${ticks.map((tick) => `
          <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="#d9e0e7" stroke-width="1" />
          <text x="${margin.left - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#51606f">${tick}m</text>
        `).join("")}
        ${distanceTicks.map((tick) => `
          <line x1="${xDistance(tick).toFixed(1)}" x2="${xDistance(tick).toFixed(1)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#edf1f4" stroke-width="1" />
          <text x="${xDistance(tick).toFixed(1)}" y="${height - 17}" text-anchor="middle" font-size="9" fill="#51606f">${tick.toFixed(0)}</text>
        `).join("")}
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#667085" />
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#667085" />
        <polyline points="${terrainPoints}" fill="none" stroke="#2f3437" stroke-width="2.5" />
        <line x1="${x(landing).toFixed(1)}" x2="${x(landing).toFixed(1)}" y1="${y(landing.groundElevation).toFixed(1)}" y2="${y(landing.chordElevation ?? landing.cableElevation).toFixed(1)}" stroke="#172033" stroke-width="4" />
        <line x1="${x(tailhold).toFixed(1)}" x2="${x(tailhold).toFixed(1)}" y1="${y(tailhold.groundElevation).toFixed(1)}" y2="${y(tailhold.chordElevation ?? tailhold.cableElevation).toFixed(1)}" stroke="#667085" stroke-width="3" />
        <polyline points="${chordPoints}" fill="none" stroke="#172033" stroke-width="1.2" stroke-dasharray="5 4" />
        <polyline points="${skylinePoints}" fill="none" stroke="#0f477a" stroke-width="3" />
        ${samples.map((sample) => `
          <circle cx="${x(sample).toFixed(1)}" cy="${y(sample.skylineElevation ?? sample.cableElevation).toFixed(1)}" r="3.8" fill="${sample.status === "green" ? "#178f48" : "#d71920"}" />
        `).join("")}
        <text x="${margin.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle" font-size="10" fill="#51606f">Distance along skyline (m)</text>
        <text x="${margin.left + 8}" y="${margin.top + 14}" font-size="10" fill="#172033">Deflection ${Number(result.deflectionPercent || 0).toFixed(0)}%</text>
      </svg>
      <div class="profile-legend">
        <span><i class="terrain-line"></i> Terrain</span>
        <span><i class="chord-line"></i> Straight chord/tight line</span>
        <span><i class="skyline-line"></i> Deflected skyline</span>
        <span><i class="report-line report-green"></i> Clearance</span>
        <span><i class="report-line report-red"></i> Below clearance / no lift</span>
      </div>
    </section>
  `;
}

function buildTicks(min, max, count) {
  const step = Math.max(1, Math.round((max - min) / count / 10) * 10);
  const ticks = [];
  for (let value = min; value <= max; value += step) ticks.push(value);
  if (!ticks.includes(max)) ticks.push(max);
  return ticks;
}

function buildDistanceTicks(maxDistance) {
  const distance = Math.max(0, Number(maxDistance) || 0);
  if (distance <= 0) return [0];
  const roughStep = distance / 6;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let value = 0; value < distance; value += step) ticks.push(value);
  ticks.push(distance);
  return ticks;
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
