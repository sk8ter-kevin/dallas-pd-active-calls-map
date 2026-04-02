"use strict";

const API_CALLS_URL = "/api/calls";
const API_REFRESH_URL = "/api/refresh";
const POLL_INTERVAL_MS = 15000;
const DALLAS_CENTER = [32.7767, -96.797];

const TILE_LAYER_URL = "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}";
const TILE_ATTRIBUTION = '&copy; Google Maps';

const PRIORITY_COLORS = {
  "1": "#ff3344",
  "2": "#ff8833",
  "3": "#ffcc00",
  "4": "#00cc66",
  default: "#5599ff",
};

// --- State ---
let allCallsRaw = [];
let consolidatedCalls = [];
let map = null;
let markerLayer = null;
let markersByIncident = new Map();
let firstLoad = true;
let consecutiveErrors = 0;
let lastDataTimestamp = null;
let stalenessTimer = null;
const MAX_DISPLAY = 200;

// Priority filter state: all active by default
const activePriorities = new Set(["1", "2", "3", "4"]);

// --- Elements ---
const el = {
  totalCalls: document.getElementById("totalCalls"),
  mappedCalls: document.getElementById("mappedCalls"),
  unmappedCalls: document.getElementById("unmappedCalls"),
  lastUpdated: document.getElementById("lastUpdated"),
  statusLine: document.getElementById("statusLine"),
  callList: document.getElementById("callList"),
  listCount: document.getElementById("listCount"),
  refreshBtn: document.getElementById("refreshBtn"),
  divisionFilter: document.getElementById("divisionFilter"),
  searchInput: document.getElementById("searchInput"),
  indicator: document.querySelector(".indicator"),
};

// --- Initialization ---

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: false
  }).setView(DALLAS_CENTER, 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

  L.tileLayer(TILE_LAYER_URL, {
    maxZoom: 20,
    attribution: TILE_ATTRIBUTION,
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
}

// --- Utils ---

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPriorityColor(p) {
  return PRIORITY_COLORS[p] || PRIORITY_COLORS.default;
}

function hasValidCoords(call) {
  return Number.isFinite(call.lat) && Number.isFinite(call.lon);
}

function formatTime(isoString) {
  if (!isoString) return "--:--";
  const date = new Date(isoString);
  return isNaN(date.getTime()) ? "--:--" : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(dateStr, timeStr) {
  try {
    const d = dateStr.split("T")[0];
    const fullStr = `${d}T${timeStr}`;
    const date = new Date(fullStr);
    if (isNaN(date.getTime())) return "";

    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  } catch (e) {
    return "";
  }
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// --- Data Processing ---

function consolidateData(rows) {
  const mapByInc = new Map();

  rows.forEach(row => {
    const inc = row.incidentNumber;
    if (!mapByInc.has(inc)) {
      mapByInc.set(inc, {
        ...row,
        units: [],
        unitCount: 0
      });
    }

    const incident = mapByInc.get(inc);
    if (row.unitNumber) {
      if (!incident.units.includes(row.unitNumber)) {
        incident.units.push(row.unitNumber);
      }
    }
  });

  return Array.from(mapByInc.values()).map(inc => {
    inc.unitCount = inc.units.length;
    return inc;
  });
}

// --- Core Logic ---

function getFilteredCalls() {
  const division = el.divisionFilter.value;
  const search = el.searchInput.value.toLowerCase().trim();

  return consolidatedCalls.filter(call => {
    // Division filter
    if (division !== "all" && call.division !== division) return false;

    // Priority filter
    const p = call.priority || "0";
    if (p !== "0" && !activePriorities.has(p)) return false;

    // Search filter
    if (search) {
      const incident = (call.incidentNumber || "").toLowerCase();
      const location = (call.address || call.location || "").toLowerCase();
      const nature = (call.natureOfCall || "").toLowerCase();
      const unitStr = call.units.join(" ").toLowerCase();

      if (!incident.includes(search) &&
        !location.includes(search) &&
        !nature.includes(search) &&
        !unitStr.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

function buildPopupContent(call) {
  const color = getPriorityColor(call.priority);
  const unitList = call.units.length > 0
    ? call.units.map(u => `<span style="background:#eee; padding:2px 4px; border-radius:3px; font-size:0.8em; color:#333; margin-right:3px">${escapeHtml(u)}</span>`).join("")
    : "N/A";

  return `
    <div style="min-width: 220px">
      <h3 style="margin:0 0 5px; color:${color}">${escapeHtml(call.natureOfCall)}</h3>
      <div style="font-size:0.9em; color: #333; line-height: 1.4">
        <strong>Pri ${call.priority || "?"}</strong> | ${escapeHtml(call.incidentNumber)}<br>
        <div style="margin: 4px 0; color:#444;">${escapeHtml(call.address || call.location)}</div>
        <div style="margin-top:8px; padding-top:6px; border-top:1px solid #eee;">
           <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
             <strong style="color:#222">Units on Scene: ${call.unitCount}</strong>
           </div>
           <div style="display:flex; flex-wrap:wrap; gap:3px;">
              ${unitList}
           </div>
        </div>
      </div>
    </div>
  `;
}

function updateMarkers(visibleCalls) {
  const mapped = visibleCalls.filter(hasValidCoords);
  const currentIds = new Set(mapped.map(c => c.incidentNumber));

  // Remove markers no longer in view
  for (const [id, marker] of markersByIncident) {
    if (!currentIds.has(id)) {
      markerLayer.removeLayer(marker);
      markersByIncident.delete(id);
    }
  }

  // Add or update markers
  mapped.forEach(call => {
    const id = call.incidentNumber;
    const color = getPriorityColor(call.priority);
    const radius = call.priority === "1" ? 12 : 8;
    const existing = markersByIncident.get(id);

    if (existing) {
      // Update position if changed
      const pos = existing.getLatLng();
      if (pos.lat !== call.lat || pos.lng !== call.lon) {
        existing.setLatLng([call.lat, call.lon]);
      }
      // Update style
      existing.setStyle({ fillColor: color, radius });
      existing.setPopupContent(buildPopupContent(call));
    } else {
      // Create new marker
      const marker = L.circleMarker([call.lat, call.lon], {
        radius,
        color: "#ffffff",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9
      });
      marker.bindPopup(buildPopupContent(call));
      markerLayer.addLayer(marker);
      markersByIncident.set(id, marker);
    }
  });
}

function renderList(calls) {
  el.listCount.textContent = calls.length;

  // Preserve scroll position
  const scrollTop = el.callList.scrollTop;

  if (calls.length === 0) {
    el.callList.innerHTML = `<li style="padding:1rem; color:#666; text-align:center">No incidents match your filter</li>`;
    return;
  }

  const truncated = calls.length > MAX_DISPLAY;
  const html = calls.slice(0, MAX_DISPLAY).map(call => {
    const p = call.priority || '?';
    const ago = timeAgo(call.date, call.time);
    const loc = call.address || call.location || "Unknown Location";
    const mappedIcon = hasValidCoords(call)
      ? `<span role="img" aria-label="Mapped" style="color:#00cc66" title="Mapped">&#x1F4CD;</span>`
      : `<span role="img" aria-label="Not mapped" style="color:#444" title="Not Mapped">&#x26AA;</span>`;

    const unitText = call.unitCount === 1
      ? `Unit ${call.units[0] || '?'}`
      : `<strong>${call.unitCount} Units</strong>`;

    const safeId = escapeHtml(call.incidentNumber);

    return `
      <li class="call-item" tabindex="0" data-incident="${safeId}">
        <div class="item-header">
           <span class="badge-priority badge-p${call.priority || '0'}">P${p}</span>
           <span class="time-ago">${ago}</span>
        </div>
        <div class="item-nature">${escapeHtml(call.natureOfCall)}</div>
        <div class="item-loc">${mappedIcon} ${escapeHtml(loc)}</div>
        <div class="item-meta">
           <span class="incident-link" data-copy="${safeId}" title="Click to copy">#${safeId}</span>
           <span style="color:#666"> | </span>
           <span style="color:#ccc">${unitText}</span>
        </div>
      </li>
    `;
  }).join("");

  el.callList.innerHTML = html
    + (truncated ? `<li style="padding:0.75rem 1rem; color:var(--text-dim); text-align:center; font-size:0.8rem">Showing ${MAX_DISPLAY} of ${calls.length} incidents</li>` : "");

  // Restore scroll position
  el.callList.scrollTop = scrollTop;
}

function updateStats(data, callsPerIncident) {
  // Priority breakdown
  const counts = { "1": 0, "2": 0, "3": 0, "4": 0 };
  callsPerIncident.forEach(c => {
    const p = c.priority;
    if (counts[p] !== undefined) counts[p]++;
  });

  el.totalCalls.innerHTML = `${callsPerIncident.length} <span style="font-size:0.6em; color:#888; text-transform:uppercase">Incidents</span>`;

  const mappedCount = callsPerIncident.filter(hasValidCoords).length;
  el.mappedCalls.textContent = mappedCount;
  el.unmappedCalls.textContent = callsPerIncident.length - mappedCount;

  // Update priority toggle badges with counts
  document.querySelectorAll(".priority-btn").forEach(btn => {
    const p = btn.dataset.priority;
    btn.textContent = `P${p} (${counts[p] || 0})`;
  });

  // Data freshness
  lastDataTimestamp = data.updatedAt ? new Date(data.updatedAt) : null;
  el.lastUpdated.textContent = formatTime(data.updatedAt);
  updateStaleness();

  if (data.error) {
    el.statusLine.textContent = `Error: ${data.error}`;
    el.statusLine.style.color = "#ff3344";
  } else {
    el.statusLine.textContent = "System Operational | Live Data";
    el.statusLine.style.color = "#00cc66";
  }
}

function updateStaleness() {
  if (!lastDataTimestamp || !el.indicator) return;
  const ageSeconds = Math.floor((Date.now() - lastDataTimestamp.getTime()) / 1000);

  el.indicator.classList.remove("stale", "warning");

  if (ageSeconds > 300) {
    // >5 min: red stale
    el.indicator.classList.add("stale");
    el.lastUpdated.style.color = "#ff3344";
    el.lastUpdated.textContent = `${Math.floor(ageSeconds / 60)}m ago`;
  } else if (ageSeconds > 120) {
    // >2 min: yellow warning
    el.indicator.classList.add("warning");
    el.lastUpdated.style.color = "#ffcc00";
    el.lastUpdated.textContent = `${Math.floor(ageSeconds / 60)}m ago`;
  } else {
    el.lastUpdated.style.color = "";
  }
}

function syncDivisions() {
  const current = el.divisionFilter.value;
  const divs = new Set(consolidatedCalls.map(c => c.division).filter(Boolean));
  const sorted = Array.from(divs).sort();

  const opts = sorted
    .map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
    .join("");
  el.divisionFilter.innerHTML = `<option value="all">ALL DIVISIONS</option>` + opts;

  if (sorted.includes(current)) el.divisionFilter.value = current;
}

// --- Actions ---

window.focusCall = function (incidentNumber) {
  const call = consolidatedCalls.find(c => c.incidentNumber === incidentNumber);
  if (!call) return;

  if (hasValidCoords(call)) {
    map.flyTo([call.lat, call.lon], 16, { animate: true, duration: 1.5 });
    const marker = markersByIncident.get(incidentNumber);
    if (marker) marker.openPopup();
  }
};

function showCopyToast(text) {
  const toast = document.createElement("div");
  toast.className = "copy-toast";
  toast.textContent = `Copied: ${text}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

function render() {
  const filtered = getFilteredCalls();
  updateMarkers(filtered);
  renderList(filtered);
}

const debouncedRender = debounce(render, 250);

async function fetchCalls() {
  el.refreshBtn.classList.add("spinning");
  try {
    const res = await fetch(API_CALLS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allCallsRaw = data.calls || [];
    consolidatedCalls = consolidateData(allCallsRaw);

    updateStats(data, consolidatedCalls);
    syncDivisions();
    if (consecutiveErrors > 0) {
      clearInterval(pollTimer);
      pollTimer = setInterval(fetchCalls, POLL_INTERVAL_MS);
    }
    consecutiveErrors = 0;

    if (firstLoad) {
      firstLoad = false;

      const mapped = consolidatedCalls.filter(hasValidCoords);
      if (mapped.length > 0) {
        const group = L.featureGroup(mapped.map(c => L.marker([c.lat, c.lon])));
        map.fitBounds(group.getBounds(), { padding: [50, 50] });
      }
    }

    render();
  } catch (e) {
    consecutiveErrors++;
    const retryIn = Math.min(consecutiveErrors * POLL_INTERVAL_MS, 60000);
    el.statusLine.textContent = `Connection lost \u2013 retrying in ${Math.round(retryIn / 1000)}s`;
    el.statusLine.style.color = "#ff3344";
    console.error("Fetch failed:", e);
    clearInterval(pollTimer);
    pollTimer = setInterval(fetchCalls, retryIn);
  } finally {
    el.refreshBtn.classList.remove("spinning");
  }
}

async function triggerRefresh() {
  el.refreshBtn.disabled = true;
  el.statusLine.textContent = "Requesting update...";
  el.statusLine.style.color = "var(--accent-primary)";
  try {
    const res = await fetch(API_REFRESH_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchCalls();
  } catch (e) {
    el.statusLine.textContent = "Refresh failed";
    el.statusLine.style.color = "#ff3344";
    console.error("Refresh failed:", e);
  } finally {
    el.refreshBtn.disabled = false;
  }
}

// --- Events ---

el.refreshBtn.addEventListener("click", triggerRefresh);
el.divisionFilter.addEventListener("change", render);
el.searchInput.addEventListener("input", debouncedRender);

// Priority toggle buttons
document.getElementById("priorityToggles").addEventListener("click", (e) => {
  const btn = e.target.closest(".priority-btn");
  if (!btn) return;

  const p = btn.dataset.priority;
  if (activePriorities.has(p)) {
    activePriorities.delete(p);
    btn.classList.remove("active");
  } else {
    activePriorities.add(p);
    btn.classList.add("active");
  }
  render();
});

// Call list: click-to-focus and copy-to-clipboard (event delegation)
el.callList.addEventListener("click", (e) => {
  // Copy incident number
  const copyTarget = e.target.closest(".incident-link");
  if (copyTarget) {
    e.stopPropagation();
    const id = copyTarget.dataset.copy;
    navigator.clipboard.writeText(id).then(() => showCopyToast(id));
    return;
  }

  // Focus call on map
  const item = e.target.closest(".call-item");
  if (item) {
    const id = item.dataset.incident;
    if (id) focusCall(id);
  }
});

// Keyboard nav on call list items
el.callList.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const item = e.target.closest(".call-item");
    if (item) focusCall(item.dataset.incident);
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement.tagName;
  const inInput = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";

  // Escape: clear search and filters
  if (e.key === "Escape") {
    el.searchInput.value = "";
    el.searchInput.blur();
    render();
    return;
  }

  // Shortcuts that only work outside inputs
  if (inInput) return;

  if (e.key === "/" || (e.ctrlKey && e.key === "k")) {
    e.preventDefault();
    el.searchInput.focus();
  } else if (e.key === "r" || e.key === "R") {
    triggerRefresh();
  }
});

// --- Staleness Checker ---
stalenessTimer = setInterval(updateStaleness, 10000);

// --- Boot ---
let pollTimer;
initMap();
fetchCalls();
pollTimer = setInterval(fetchCalls, POLL_INTERVAL_MS);
