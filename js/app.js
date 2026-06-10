/* ADS-B 3D Trajectory Viewer — deck.gl edition
 * Parses dump1090 CSV logs and renders trajectories as PathLayers above a
 * deck.gl TerrainLayer that streams Mapzen terrarium elevation tiles with
 * camera-based level of detail, draped with Esri World Imagery. Airports
 * (OurAirports dataset) and each aircraft's latest position are labeled.
 */
"use strict";

const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const IMAGERY_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const GAP_BREAK_MS = 10 * 60 * 1000;   // break trajectory paths across signal gaps
const BBOX_MARGIN = 0.08;              // fraction of span added around trajectories
const MIN_SPAN_DEG = 0.4;              // minimum bbox span so tiny datasets still get context

const PALETTE = [
  [88, 166, 255], [247, 129, 102], [86, 211, 100], [227, 179, 65], [188, 140, 255],
  [57, 197, 207], [255, 123, 114], [126, 231, 135], [255, 166, 87], [210, 168, 255],
  [121, 192, 255], [255, 190, 221], [158, 203, 255], [240, 136, 62], [111, 221, 139],
  [251, 214, 105], [203, 166, 247], [118, 227, 234],
];

const $ = id => document.getElementById(id);
const statusEl = $("status");

let deckgl = null;       // created lazily on first render
let airportsDb = null;   // lazily fetched data/airports.json
let scene = null;        // { segments, lastPoints, airports, counts } for the loaded CSV

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// frac in [0,1] shows the bar; null hides it
function setProgress(frac) {
  const bar = $("progress");
  if (frac === null) { bar.classList.remove("active"); return; }
  bar.classList.add("active");
  $("progress-fill").style.width = `${Math.round(Math.min(frac, 1) * 100)}%`;
}

// Let the browser paint a status update before blocking the main thread
const paint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

/* ---------------- CSV parsing ---------------- */

// Header aliases -> canonical field. First alias that matches (substring) wins.
function mapHeader(names) {
  const find = (...subs) => names.findIndex(n => subs.some(s => n.includes(s)));
  const col = {
    hex: find("hex", "icao24", "icao"),
    lat: find("latitude", "lat"),
    lon: find("longitude", "lon", "lng"),
    alt: find("altitude", "alt"),
    date: names.findIndex(n => n === "date" || n.startsWith("date")),
    time: names.findIndex(n => n === "time" || n.startsWith("time")),
    ts: find("timestamp", "datetime"),
    callsign: find("callsign", "flight"),
    speed: find("ground_speed", "speed", "gs"),
  };
  const altName = col.alt >= 0 ? names[col.alt] : "";
  // dump1090/SBS logs report feet unless the header says otherwise
  col.altToMeters = /meter|metre|\(m\)/.test(altName) ? 1 : 0.3048;
  const spdName = col.speed >= 0 ? names[col.speed] : "";
  col.spdToKmh = /km|kilometer/.test(spdName) ? 1 : 1.852;
  return col;
}

function parseDateTime(dateStr, timeStr) {
  const d = dateStr.split(/[/\-.]/).map(Number);
  if (d.length !== 3) return NaN;
  const t = timeStr.split(":");
  const sec = parseFloat(t[2] || "0");
  return Date.UTC(d[0], d[1] - 1, d[2], +t[0] || 0, +t[1] || 0,
                  Math.floor(sec), Math.round((sec % 1) * 1000));
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error("File has no data rows.");
  const names = lines[0].split(",").map(s => s.trim().toLowerCase());
  const col = mapHeader(names);
  if (col.hex < 0 || col.lat < 0 || col.lon < 0 || col.alt < 0) {
    throw new Error("Could not find hex/lat/lon/altitude columns in the header.");
  }
  if (col.ts < 0 && (col.date < 0 || col.time < 0)) {
    throw new Error("Could not find a timestamp (or date + time) column.");
  }

  const aircraft = new Map();
  let bad = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split(",");
    const lat = parseFloat(f[col.lat]);
    const lon = parseFloat(f[col.lon]);
    const alt = parseFloat(f[col.alt]) * col.altToMeters;
    const t = col.ts >= 0 ? Date.parse(f[col.ts])
                          : parseDateTime(f[col.date] || "", f[col.time] || "");
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt) || !isFinite(t) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180 || alt < -100 || alt > 25000) {
      bad++;
      continue;
    }
    const hex = (f[col.hex] || "").trim();
    if (!hex) { bad++; continue; }
    let rec = aircraft.get(hex);
    if (!rec) { rec = { callsign: "", points: [] }; aircraft.set(hex, rec); }
    const cs = col.callsign >= 0 ? (f[col.callsign] || "").trim() : "";
    if (cs) rec.callsign = cs;
    const spdRaw = col.speed >= 0 ? parseFloat(f[col.speed]) : NaN;
    rec.points.push({
      t, lat, lon, alt,
      spd: isFinite(spdRaw) ? spdRaw * col.spdToKmh : null,
    });
  }
  if (aircraft.size === 0) throw new Error("No valid position rows found.");
  return { aircraft, bad };
}

/* ---------------- Scene data ---------------- */

const fmtTime = t => new Date(t).toISOString().slice(11, 19);

// Per-aircraft gap-split path segments plus the latest point for labeling
function buildScene(aircraft) {
  const segments = [];
  const lastPoints = [];
  let total = 0;
  let colorIdx = 0;
  const sorted = [...aircraft.entries()].sort((a, b) => b[1].points.length - a[1].points.length);
  for (const [hex, rec] of sorted) {
    rec.points.sort((a, b) => a.t - b.t);
    const label = rec.callsign || hex;
    const lastPt = rec.points[rec.points.length - 1];
    lastPoints.push({ lon: lastPt.lon, lat: lastPt.lat, alt: lastPt.alt,
                      t: lastPt.t, label, hex });
    if (rec.points.length < 2) continue;
    total += rec.points.length;
    const color = PALETTE[colorIdx++ % PALETTE.length];
    let cur = null;
    let prevT = null;
    for (const p of rec.points) {
      if (cur === null || p.t - prevT > GAP_BREAK_MS) {
        cur = { path: [], color, label, hex,
                t0: p.t, t1: p.t, altMin: p.alt, altMax: p.alt };
        segments.push(cur);
      }
      cur.path.push([p.lon, p.lat, p.alt]);
      cur.t1 = p.t;
      if (p.alt < cur.altMin) cur.altMin = p.alt;
      if (p.alt > cur.altMax) cur.altMax = p.alt;
      prevT = p.t;
    }
  }
  return { segments: segments.filter(s => s.path.length >= 2), lastPoints, total,
           plotted: new Set(segments.map(s => s.hex)).size };
}

function dataBbox(aircraft) {
  let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
  for (const rec of aircraft.values()) {
    for (const p of rec.points) {
      if (p.lat < latMin) latMin = p.lat;
      if (p.lat > latMax) latMax = p.lat;
      if (p.lon < lonMin) lonMin = p.lon;
      if (p.lon > lonMax) lonMax = p.lon;
    }
  }
  const dLat = Math.max((latMax - latMin) * BBOX_MARGIN, (MIN_SPAN_DEG - (latMax - latMin)) / 2, 0.02);
  const dLon = Math.max((lonMax - lonMin) * BBOX_MARGIN, (MIN_SPAN_DEG - (lonMax - lonMin)) / 2, 0.02);
  return {
    latMin: Math.max(latMin - dLat, -85), latMax: Math.min(latMax + dLat, 85),
    lonMin: Math.max(lonMin - dLon, -180), lonMax: Math.min(lonMax + dLon, 180),
  };
}

/* ---------------- Airports ---------------- */

async function loadAirportsDb() {
  if (!airportsDb) {
    const resp = await fetch("data/airports.json");
    if (!resp.ok) throw new Error(`airports.json: HTTP ${resp.status}`);
    airportsDb = await resp.json();
  }
  return airportsDb;
}

/* ---------------- deck.gl layers ---------------- */

function vScale() { return parseFloat($("vscale").value); }

function makeLayers() {
  if (!scene) return [];
  const f = vScale();
  const layers = [
    new deck.TerrainLayer({
      id: "terrain",
      elevationData: TERRAIN_TILES,
      texture: IMAGERY_TILES,
      // terrarium decode is (R*256 + G + B/256) - 32768; scale it for exaggeration
      elevationDecoder: { rScaler: 256 * f, gScaler: f, bScaler: f / 256, offset: -32768 * f },
      minZoom: 0,
      maxZoom: 14,
      strategy: "no-overlap",
      updateTriggers: { elevationDecoder: f },
    }),
    new deck.PathLayer({
      id: "paths",
      data: scene.segments,
      getPath: d => d.path.map(p => [p[0], p[1], p[2] * f]),
      getColor: d => d.color,
      widthMinPixels: 2,
      widthMaxPixels: 4,
      opacity: 0.85,
      pickable: true,
      updateTriggers: { getPath: f },
    }),
  ];
  if ($("cb-airports").checked && scene.airports.length) {
    layers.push(
      new deck.ScatterplotLayer({
        id: "airport-dots",
        data: scene.airports,
        getPosition: a => [a.lo, a.la, (a.e || 0) * f + 40],
        getFillColor: [255, 92, 92, 230],
        radiusMinPixels: 4,
        radiusMaxPixels: 7,
        pickable: true,
        updateTriggers: { getPosition: f },
      }),
      new deck.TextLayer({
        id: "airport-codes",
        data: scene.airports,
        getPosition: a => [a.lo, a.la, (a.e || 0) * f + 40],
        getText: a => a.a || a.i,
        getSize: 12,
        getColor: [255, 138, 138],
        getPixelOffset: [0, -14],
        characterSet: "auto",
        fontFamily: "Segoe UI, sans-serif",
        outlineWidth: 2,
        outlineColor: [13, 17, 23, 220],
        fontSettings: { sdf: true },
        updateTriggers: { getPosition: f },
      })
    );
  }
  if ($("cb-callsigns").checked) {
    layers.push(new deck.TextLayer({
      id: "callsigns",
      data: scene.lastPoints,
      getPosition: p => [p.lon, p.lat, p.alt * f],
      getText: p => p.label,
      getSize: 11,
      getColor: [230, 237, 243],
      getPixelOffset: [0, -12],
      characterSet: "auto",
      fontFamily: "Segoe UI, sans-serif",
      outlineWidth: 2,
      outlineColor: [13, 17, 23, 220],
      fontSettings: { sdf: true },
      pickable: true,
      updateTriggers: { getPosition: f },
    }));
  }
  return layers;
}

const TOOLTIP_STYLE = {
  backgroundColor: "#161b22",
  color: "#e6edf3",
  fontSize: "12px",
  border: "1px solid #30363d",
  borderRadius: "6px",
  padding: "6px 8px",
};

function getTooltip({ object, layer }) {
  if (!object) return null;
  let html = "";
  if (layer.id === "paths") {
    html = `<b>${object.label}</b> (${object.hex})<br>` +
           `${fmtTime(object.t0)}–${fmtTime(object.t1)} UTC<br>` +
           `alt ${Math.round(object.altMin)}–${Math.round(object.altMax)} m`;
  } else if (layer.id.startsWith("airport")) {
    html = `<b>${object.n}</b> (${object.i}${object.a ? "/" + object.a : ""})<br>elev ${object.e} m`;
  } else if (layer.id === "callsigns") {
    html = `<b>${object.label}</b> (${object.hex})<br>` +
           `last seen ${fmtTime(object.t)} UTC<br>alt ${Math.round(object.alt)} m`;
  } else {
    return null;
  }
  return { html, style: TOOLTIP_STYLE };
}

function updateLayers() {
  if (deckgl && scene) deckgl.setProps({ layers: makeLayers() });
}

function fitViewState(bbox) {
  const wrap = $("deck-wrap");
  const vp = new deck.WebMercatorViewport({
    width: Math.max(wrap.clientWidth, 100),
    height: Math.max(wrap.clientHeight, 100),
  });
  const { longitude, latitude, zoom } = vp.fitBounds(
    [[bbox.lonMin, bbox.latMin], [bbox.lonMax, bbox.latMax]], { padding: 60 });
  return { longitude, latitude, zoom, pitch: 55, bearing: -20,
           maxPitch: 85, minZoom: 3, maxZoom: 16 };
}

/* ---------------- Render pipeline ---------------- */

async function render(text, sourceName) {
  setStatus(`Processing ${sourceName}…`);
  setProgress(null);
  $("empty-hint").style.display = "none";
  await paint();
  try {
    const { aircraft, bad } = parseCSV(text);
    const { segments, lastPoints, total, plotted } = buildScene(aircraft);
    const bbox = dataBbox(aircraft);

    setStatus("Loading airport database…");
    let airports = [];
    let airportsWarn = false;
    try {
      const db = await loadAirportsDb();
      airports = db.filter(a => a.la >= bbox.latMin && a.la <= bbox.latMax &&
                                a.lo >= bbox.lonMin && a.lo <= bbox.lonMax);
    } catch (err) {
      console.error(err);
      airportsWarn = true;
    }

    scene = { segments, lastPoints, airports };

    if (!deckgl) {
      deckgl = new deck.DeckGL({
        container: "deck-wrap",
        controller: { inertia: 250 },
        initialViewState: fitViewState(bbox),
        layers: [],
        getTooltip,
      });
    } else {
      deckgl.setProps({ initialViewState: fitViewState(bbox) });
    }
    updateLayers();

    const days = new Set(lastPoints.map(p => new Date(p.t).toISOString().slice(0, 10)));
    const parts = [
      `${plotted} aircraft`,
      `${total.toLocaleString()} points`,
      [...days].sort().join(", ") + " UTC",
      `${airports.length} airports`,
      "terrain streams with the camera (LOD up to z14)",
      bad ? `${bad} rows skipped` : null,
      airportsWarn ? "⚠ airport db unavailable" : null,
    ].filter(Boolean);
    setStatus(parts.join(" | "), airportsWarn);
  } catch (err) {
    console.error(err);
    setProgress(null);
    setStatus(`Error: ${err.message}`, true);
  }
}

/* ---------------- UI wiring ---------------- */

// Streaming download so large files show byte progress. With gzip transfer the
// Content-Length is the compressed size, so the fraction is clamped to 1.
async function downloadWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = +resp.headers.get("Content-Length") || 0;
  if (!resp.body || !total) {
    setStatus(`Downloading ${label}…`);
    return resp.text();
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    setStatus(`Downloading ${label}… ${(got / 1048576).toFixed(1)} MB`);
    setProgress(got / total);
  }
  setProgress(null);
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder().decode(buf);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => render(reader.result, file.name);
  reader.onerror = () => setStatus("Could not read file.", true);
  reader.readAsText(file);
}

$("file-input").addEventListener("change", e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = "";
});

$("sample-btn").addEventListener("click", async () => {
  try {
    const text = await downloadWithProgress("data/sample.csv", "sample data");
    render(text, "sample.csv");
  } catch (err) {
    setProgress(null);
    setStatus(`Error: ${err.message}`, true);
  }
});

$("cb-callsigns").addEventListener("change", updateLayers);
$("cb-airports").addEventListener("change", updateLayers);

$("vscale").addEventListener("input", () => {
  $("vscale-val").textContent = vScale().toFixed(2).replace(/\.?0+$/, "");
});
$("vscale").addEventListener("change", updateLayers);

let dragDepth = 0;
document.addEventListener("dragenter", e => {
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth === 0) document.body.classList.remove("dragging");
});
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
