"use strict";

const API_CALLS_URL = "/api/calls";
const API_REFRESH_URL = "/api/refresh";
const POLL_INTERVAL_MS = 15000; // Faster polling for command center feel
const DALLAS_CENTER = [32.7767, -96.797];

// Google Maps Tiles (Hybrid for "Command Center" feel, or Streets)
// mt0, mt1, mt2, mt3 are mirrors
// lyrs=m (streets), s (satellite), y (hybrid), p (terrain)
const TILE_LAYER_URL = "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}";
const TILE_ATTRIBUTION = '&copy; Google Maps';

const PRIORITY_COLORS = {
  "1": "#ff3344", // Critical
  "2": "#ff8833", // Urgent
  "3": "#ffcc00", // Standard
  "4": "#00cc66", // Non-Emergency
  default: "#5599ff", // Unknown
};

// --- State ---
let allCallsRaw = [];        // distinct rows (one per unit)
let consolidatedCalls = [];  // one per incident, with 'units' array
let map = null;
let markerLayer = null;
let markersByIncident = new Map();
let firstLoad = true;

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
};

// --- Initialization ---

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: false
  }).setView(DALLAS_CENTER, 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  // Leaflet requires attribution, but for Google Tiles commonly people just credit Google
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

function formatTime(isoString) {
  if (!isoString) return "--:--";
  const date = new Date(isoString);
  return isNaN(date.getTime()) ? "--:--" : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(dateStr, timeStr) {
  // Combine date and time if possible, or just parse what we can
  // The API gives separate date "2023-10-27T00:00:00.000" and time "14:30" usually
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

// --- Data Processing ---

function consolidateData(rows) {
  const mapByInc = new Map();

  rows.forEach(row => {
    const inc = row.incidentNumber;
    if (!mapByInc.has(inc)) {
      // Clone the row as the base incident
      mapByInc.set(inc, {
        ...row,
        units: [],
        unitCount: 0
      });
    }

    const incident = mapByInc.get(inc);
    // Add unit if present
    if (row.unitNumber) {
      if (!incident.units.includes(row.unitNumber)) {
        incident.units.push(row.unitNumber);
      }
    }
  });

  // Finalize counts
  return Array.from(mapByInc.values()).map(inc => {
    inc.unitCount = inc.units.length;
    // ensure lat/lon is consistent (sometimes only one row has it, though unlikely with current backend)
    // backend fills coordinates for all rows of same address, so we just take the first one
    return inc;
  });
}

// --- Core Logic ---

function getFilteredCalls() {
  const division = el.divisionFilter.value;
  const search = el.searchInput.value.toLowerCase().trim();

  return consolidatedCalls.filter(call => {
    // Division Filter
    if (division !== "all" && call.division !== division) return false;

    // Search Filter
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

function updateMarkers(visibleCalls) {
  // We rebuild the layer group but try to animate in future iterations
  // For now, clear and redraw is robust
  markerLayer.clearLayers();
  markersByIncident.clear();

  const mapped = visibleCalls.filter(c => c.lat != null && c.lon != null);

  mapped.forEach(call => {
    const color = getPriorityColor(call.priority);
    const pulseRadius = call.priority === "1" ? 12 : 8;

    // Circle Marker
    const marker = L.circleMarker([call.lat, call.lon], {
      radius: pulseRadius,
      color: "#ffffff",
      weight: 1,
      fillColor: color,
      fillOpacity: 0.9
    });

    // Unit Badge if > 1 unit
    // (Leaflet can't easily put text inside CircleMarker without a plugin, 
    // so we'll rely on tooltip for count or just size/color)

    // Tooltip/Popup
    const unitList = call.units.length > 0
      ? call.units.map(u => `<span style="background:#eee; padding:2px 4px; border-radius:3px; font-size:0.8em; color:#333; margin-right:3px">${escapeHtml(u)}</span>`).join("")
      : "N/A";

    const popupContent = `
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

    marker.bindPopup(popupContent);
    marker.on('click', () => {
      // Future: Highlight in list
    });

    markerLayer.addLayer(marker);
    markersByIncident.set(call.incidentNumber, marker);
  });
}

function renderList(calls) {
  el.listCount.textContent = calls.length;

  if (calls.length === 0) {
    el.callList.innerHTML = `<li style="padding:1rem; color:#666; text-align:center">No incidents match your filter</li>`;
    return;
  }

  const html = calls.slice(0, 100).map(call => {
    const p = call.priority || '?';
    const ago = timeAgo(call.date, call.time);
    const loc = call.address || call.location || "Unknown Location";
    const mappedIcon = (call.lat && call.lon)
      ? `<span style="color:#00cc66" title="Mapped">📍</span>`
      : `<span style="color:#444" title="Not Mapped">⚪</span>`;

    // Unit display
    const unitText = call.unitCount === 1
      ? `Unit ${call.units[0] || '?'}`
      : `<strong>${call.unitCount} Units</strong>`;

    return `
      <li class="call-item" onclick="focusCall('${call.incidentNumber}')">
        <div class="item-header">
           <span class="badge-priority badge-p${call.priority || '0'}">P${p}</span>
           <span class="time-ago">${ago}</span>
        </div>
        <div class="item-nature">${escapeHtml(call.natureOfCall)}</div>
        <div class="item-loc">${mappedIcon} ${escapeHtml(loc)}</div>
        <div class="item-meta">
           <span style="color:#aaa">#${escapeHtml(call.incidentNumber)}</span>
           <span style="color:#666"> | </span> 
           <span style="color:#ccc">${unitText}</span>
        </div>
      </li>
    `;
  }).join("");

  el.callList.innerHTML = html;
}

function updateStats(data, callsPerIncident) {
  // data.totalCalls is raw rows from backend. 
  // We should also show total INCIDENTS.

  el.totalCalls.innerHTML = `${callsPerIncident.length} <span style="font-size:0.6em; color:#888; text-transform:uppercase">Incidents</span>`;

  // Recalculate mapped/unmapped based on incidents, not rows
  const mappedCount = callsPerIncident.filter(c => c.lat && c.lon).length;
  el.mappedCalls.textContent = mappedCount;
  el.unmappedCalls.textContent = callsPerIncident.length - mappedCount;

  el.lastUpdated.textContent = formatTime(data.updatedAt);

  if (data.error) {
    el.statusLine.textContent = `Error: ${data.error}`;
    el.statusLine.style.color = "#ff3344";
  } else {
    el.statusLine.textContent = "System Operational | Live Data";
    el.statusLine.style.color = "#00cc66";
  }
}

function syncDivisions() {
  const current = el.divisionFilter.value;
  const divs = new Set(consolidatedCalls.map(c => c.division).filter(Boolean));
  const sorted = Array.from(divs).sort();

  const opts = sorted.map(d => `<option value="${d}">${d}</option>`).join("");
  el.divisionFilter.innerHTML = `<option value="all">ALL DIVISIONS</option>` + opts;

  if (sorted.includes(current)) el.divisionFilter.value = current;
}

// Global scope for onclick
window.focusCall = function (incidentNumber) {
  const call = consolidatedCalls.find(c => c.incidentNumber === incidentNumber);
  if (!call) return;

  if (call.lat && call.lon) {
    map.flyTo([call.lat, call.lon], 16, { animate: true, duration: 1.5 });
    const marker = markersByIncident.get(incidentNumber);
    if (marker) marker.openPopup();
  } else {
    alert("Location not mapped yet.");
  }
};

function render() {
  const filtered = getFilteredCalls();
  updateMarkers(filtered);
  renderList(filtered);
}

async function fetchCalls() {
  el.refreshBtn.classList.add("spinning"); // pure css spin animation if we had it
  try {
    const res = await fetch(API_CALLS_URL);
    const data = await res.json();

    allCallsRaw = data.calls || [];
    consolidatedCalls = consolidateData(allCallsRaw);

    updateStats(data, consolidatedCalls);

    if (firstLoad) {
      syncDivisions();
      firstLoad = false;

      // Auto-fit bounds if we have points
      const mapped = consolidatedCalls.filter(c => c.lat && c.lon);
      if (mapped.length > 0) {
        const group = L.featureGroup(mapped.map(c => L.marker([c.lat, c.lon])));
        map.fitBounds(group.getBounds(), { padding: [50, 50] });
      }
    }

    render();
  } catch (e) {
    el.statusLine.textContent = "Connection Lost";
    el.statusLine.style.color = "red";
    console.error(e);
  } finally {
    el.refreshBtn.classList.remove("spinning");
  }
}

async function triggerRefresh() {
  el.refreshBtn.disabled = true;
  el.statusLine.textContent = "Requesting update...";
  try {
    await fetch(API_REFRESH_URL);
    setTimeout(fetchCalls, 1000); // Wait a bit for backend to process
  } catch (e) {
    console.error(e);
  } finally {
    el.refreshBtn.disabled = false;
  }
}

// --- Events ---

el.refreshBtn.addEventListener("click", triggerRefresh);
el.divisionFilter.addEventListener("change", render);
el.searchInput.addEventListener("input", render);

// --- Boot ---
initMap();
fetchCalls();
setInterval(fetchCalls, POLL_INTERVAL_MS);
