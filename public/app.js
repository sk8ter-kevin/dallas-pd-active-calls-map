"use strict";

const API_CALLS_URL = "/api/calls";
const API_REFRESH_URL = "/api/refresh";
const POLL_INTERVAL_MS = 45000;
const DALLAS_CENTER = [32.7767, -96.797];
const PRIORITY_COLORS = {
  "1": "#bd1f2d",
  "2": "#eb6f29",
  "3": "#d6a81e",
  "4": "#2f8f55",
  default: "#3770bf",
};

const map = L.map("map", { zoomControl: false }).setView(DALLAS_CENTER, 11);
L.control
  .zoom({
    position: "topright",
  })
  .addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const markerByIncident = new Map();
let allCalls = [];
let lastFitDone = false;

const totalCallsEl = document.getElementById("totalCalls");
const mappedCallsEl = document.getElementById("mappedCalls");
const unmappedCallsEl = document.getElementById("unmappedCalls");
const statusLineEl = document.getElementById("statusLine");
const callListEl = document.getElementById("callList");
const refreshBtnEl = document.getElementById("refreshBtn");
const divisionFilterEl = document.getElementById("divisionFilter");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getPriorityColor(priority) {
  return PRIORITY_COLORS[priority] || PRIORITY_COLORS.default;
}

function getPriorityClass(priority) {
  return `priority-${["1", "2", "3", "4"].includes(priority) ? priority : "0"}`;
}

function formatTimestamp(isoString) {
  const timestamp = Date.parse(isoString || "");
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function formatCallDateTime(call) {
  const dateToken = (call.date || "").slice(0, 10);
  const timeToken = call.time || "";
  if (!dateToken || !timeToken) {
    return "time unavailable";
  }

  const parsed = Date.parse(`${dateToken}T${timeToken}`);
  if (!Number.isFinite(parsed)) {
    return `${dateToken} ${timeToken}`;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(parsed));
}

function buildPopupHtml(call) {
  return `
    <div>
      <p class="popup-title"><strong>${escapeHtml(call.natureOfCall || "Unknown call type")}</strong></p>
      <p class="popup-meta"><strong>Incident:</strong> ${escapeHtml(call.incidentNumber || "N/A")}</p>
      <p class="popup-meta"><strong>Priority:</strong> ${escapeHtml(call.priority || "N/A")}</p>
      <p class="popup-meta"><strong>Division:</strong> ${escapeHtml(call.division || "N/A")} | <strong>Beat:</strong> ${escapeHtml(call.beat || "N/A")}</p>
      <p class="popup-meta"><strong>Unit:</strong> ${escapeHtml(call.unitNumber || "N/A")}</p>
      <p class="popup-meta"><strong>Status:</strong> ${escapeHtml(call.status || "N/A")}</p>
      <p class="popup-meta"><strong>Address:</strong> ${escapeHtml(call.address || call.location || "N/A")}</p>
      <p class="popup-meta"><strong>Time:</strong> ${escapeHtml(formatCallDateTime(call))}</p>
    </div>
  `;
}

function upsertMarker(call) {
  if (!Number.isFinite(call.lat) || !Number.isFinite(call.lon)) {
    return;
  }

  const color = getPriorityColor(call.priority);
  const marker = L.circleMarker([call.lat, call.lon], {
    radius: 7,
    color,
    fillColor: color,
    fillOpacity: 0.88,
    weight: 1.2,
  }).bindPopup(buildPopupHtml(call));

  markerByIncident.set(call.incidentNumber, marker);
  markerLayer.addLayer(marker);
}

function clearAndRenderMarkers(calls) {
  markerLayer.clearLayers();
  markerByIncident.clear();

  const mappedCalls = calls.filter(
    (call) => Number.isFinite(call.lat) && Number.isFinite(call.lon)
  );

  for (const call of mappedCalls) {
    upsertMarker(call);
  }

  if (!lastFitDone && mappedCalls.length > 0) {
    const bounds = L.latLngBounds(mappedCalls.map((call) => [call.lat, call.lon]));
    map.fitBounds(bounds.pad(0.18));
    lastFitDone = true;
  }
}

function renderCallList(calls) {
  if (calls.length === 0) {
    callListEl.innerHTML = '<li class="call-item">No active calls in this filter.</li>';
    return;
  }

  const items = calls
    .slice(0, 250)
    .map((call) => {
      const priorityClass = getPriorityClass(call.priority);
      const resolvedLocation = call.address || call.location || "Location unavailable";
      const mappedText = Number.isFinite(call.lat) && Number.isFinite(call.lon) ? "Mapped" : "Unmapped";

      return `
        <li class="call-item">
          <div class="call-top">
            <p class="call-incident">${escapeHtml(call.incidentNumber || "No incident #")}</p>
            <span class="pill ${priorityClass}">P${escapeHtml(call.priority || "?")}</span>
          </div>
          <p class="call-nature">${escapeHtml(call.natureOfCall || "Unknown call type")}</p>
          <p class="call-meta">${escapeHtml(resolvedLocation)}</p>
          <p class="call-meta">${escapeHtml(call.division || "Unknown division")} | Beat ${escapeHtml(call.beat || "N/A")} | ${escapeHtml(mappedText)}</p>
          <p class="call-meta">${escapeHtml(formatCallDateTime(call))}</p>
        </li>
      `;
    })
    .join("");

  callListEl.innerHTML = items;
}

function getFilteredCalls() {
  const divisionValue = divisionFilterEl.value;
  if (divisionValue === "all") {
    return allCalls;
  }

  return allCalls.filter((call) => call.division === divisionValue);
}

function syncDivisionFilter(calls) {
  const current = divisionFilterEl.value || "all";
  const divisions = [...new Set(calls.map((call) => call.division).filter(Boolean))].sort();

  divisionFilterEl.innerHTML = `<option value="all">All divisions</option>${divisions
    .map((division) => `<option value="${escapeHtml(division)}">${escapeHtml(division)}</option>`)
    .join("")}`;

  if (divisions.includes(current)) {
    divisionFilterEl.value = current;
  } else {
    divisionFilterEl.value = "all";
  }
}

function updateStatus(data) {
  totalCallsEl.textContent = String(data.totalCalls ?? 0);
  mappedCallsEl.textContent = String(data.mappedCalls ?? 0);
  unmappedCallsEl.textContent = String(data.unmappedCalls ?? 0);

  const updatedAtLabel = formatTimestamp(data.updatedAt);
  const geocodeLabel = `geocode attempts this cycle: ${data.geocodeAttemptsThisRun ?? 0}`;
  const errorLabel = data.error ? ` | error: ${data.error}` : "";
  statusLineEl.textContent = `Updated: ${updatedAtLabel} | ${geocodeLabel}${errorLabel}`;
}

function render() {
  const calls = getFilteredCalls();
  clearAndRenderMarkers(calls);
  renderCallList(calls);
}

async function fetchCalls() {
  const response = await fetch(API_CALLS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function pullLatest() {
  try {
    const data = await fetchCalls();
    allCalls = Array.isArray(data.calls) ? data.calls : [];
    syncDivisionFilter(allCalls);
    updateStatus(data);
    render();
  } catch (error) {
    statusLineEl.textContent = `Unable to load active calls: ${error.message}`;
  }
}

async function triggerServerRefresh() {
  refreshBtnEl.disabled = true;
  refreshBtnEl.textContent = "Refreshing...";
  try {
    await fetch(API_REFRESH_URL, { method: "GET", cache: "no-store" });
    await sleep(350);
    await pullLatest();
  } finally {
    refreshBtnEl.disabled = false;
    refreshBtnEl.textContent = "Refresh Now";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

divisionFilterEl.addEventListener("change", render);
refreshBtnEl.addEventListener("click", triggerServerRefresh);

pullLatest();
setInterval(pullLatest, POLL_INTERVAL_MS);
