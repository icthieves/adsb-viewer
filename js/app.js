/* ADS-B 3D Trajectory Viewer
 * Parses dump1090 CSV logs, renders trajectories with Plotly, drapes a terrain
 * surface (AWS Terrain Tiles, terrarium encoding) under the flight paths, and
 * labels airports (OurAirports dataset) plus each aircraft's latest position.
 */
"use strict";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const GAP_BREAK_MS = 10 * 60 * 1000;   // break trajectory lines across signal gaps
const MAX_TILES = 30;                  // terrain download budget per render
const GRID_TARGET_W = 250;             // terrain grid width after downsampling
const BBOX_MARGIN = 0.08;              // fraction of span added around trajectories
const MIN_SPAN_DEG = 0.4;              // minimum bbox span so tiny datasets still get context
const WATER_SENTINEL = -500;           // surfacecolor value for sea cells (wide colorscale band)
const CMAX_FLOOR = 1500;               // minimum colorscale top (m) so lowlands don't all turn white

const PALETTE = ["#58a6ff", "#f78166", "#56d364", "#e3b341", "#bc8cff", "#39c5cf",
                 "#ff7b72", "#7ee787", "#ffa657", "#d2a8ff", "#79c0ff", "#ffbedd",
                 "#9ecbff", "#f0883e", "#6fdd8b", "#fbd669", "#cba6f7", "#76e3ea"];

const $ = id => document.getElementById(id);
const statusEl = $("status");
const plotEl = $("plot");

let airportsDb = null;        // lazily fetched data/airports.json
let traceIndex = {};          // {airports: i, labels: i} for checkbox toggles
let zAspectMax = 1;           // horizontal aspect max, for the vertical-scale slider

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

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

/* ---------------- Trajectory traces ---------------- */

const fmtTime = t => new Date(t).toISOString().slice(11, 19);

function buildTrajectories(aircraft) {
  const traces = [];
  const last = [];   // most recent point per aircraft, for callsign labels
  let total = 0;
  const sorted = [...aircraft.entries()].sort((a, b) => b[1].points.length - a[1].points.length);
  for (const [hex, rec] of sorted) {
    rec.points.sort((a, b) => a.t - b.t);
    const label = rec.callsign || hex;
    const p = rec.points[rec.points.length - 1];
    last.push({ ...p, label, hex });
    if (rec.points.length < 2) continue;
    total += rec.points.length;
    const x = [], y = [], z = [], text = [];
    let prev = null;
    for (const pt of rec.points) {
      if (prev !== null && pt.t - prev > GAP_BREAK_MS) {
        x.push(null); y.push(null); z.push(null); text.push("");
      }
      x.push(pt.lon); y.push(pt.lat); z.push(pt.alt);
      const spd = pt.spd !== null ? `${Math.round(pt.spd)} km/h` : "n/a";
      text.push(`${label} (${hex})<br>alt ${Math.round(pt.alt)} m | ${spd}<br>${fmtTime(pt.t)} UTC`);
      prev = pt.t;
    }
    traces.push({
      type: "scatter3d", mode: "lines", name: label,
      x, y, z, text, hoverinfo: "text",
      line: { color: PALETTE[traces.length % PALETTE.length], width: 3 },
      opacity: 0.85,
    });
  }
  return { traces, last, total };
}

/* ---------------- Terrain (terrarium tiles) ---------------- */

const lonToPx = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const latToPx = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * 256 * 2 ** z;
};
const pxToLat = (y, z) => {
  const n = Math.PI * (1 - 2 * y / (256 * 2 ** z));
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
};

function pickZoom(bbox) {
  for (let z = 11; z >= 3; z--) {
    const tx = Math.floor(lonToPx(bbox.lonMax, z) / 256) - Math.floor(lonToPx(bbox.lonMin, z) / 256) + 1;
    const ty = Math.floor(latToPx(bbox.latMin, z) / 256) - Math.floor(latToPx(bbox.latMax, z) / 256) + 1;
    if (tx * ty <= MAX_TILES) return z;
  }
  return 3;
}

function loadTile(z, x, y) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile ${z}/${x}/${y} failed`));
    img.src = TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  });
}

async function fetchTerrain(bbox, onProgress) {
  const z = pickZoom(bbox);
  const x0 = Math.floor(lonToPx(bbox.lonMin, z) / 256);
  const x1 = Math.floor(lonToPx(bbox.lonMax, z) / 256);
  const y0 = Math.floor(latToPx(bbox.latMax, z) / 256);
  const y1 = Math.floor(latToPx(bbox.latMin, z) / 256);
  const tilesX = x1 - x0 + 1, tilesY = y1 - y0 + 1;

  const canvas = document.createElement("canvas");
  canvas.width = tilesX * 256;
  canvas.height = tilesY * 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const jobs = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) jobs.push({ tx, ty });
  let done = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (jobs.length) {
      const { tx, ty } = jobs.pop();
      const img = await loadTile(z, tx, ty);
      ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
      onProgress(++done, tilesX * tilesY);
    }
  });
  await Promise.all(workers);

  // Decode terrarium RGB -> elevation, cropped to the bbox
  const pxL = Math.floor(lonToPx(bbox.lonMin, z) - x0 * 256);
  const pxR = Math.floor(lonToPx(bbox.lonMax, z) - x0 * 256);
  const pxT = Math.floor(latToPx(bbox.latMax, z) - y0 * 256);
  const pxB = Math.floor(latToPx(bbox.latMin, z) - y0 * 256);
  const w = pxR - pxL, h = pxB - pxT;
  const rgba = ctx.getImageData(pxL, pxT, w, h).data;

  const step = Math.max(1, Math.round(w / GRID_TARGET_W));
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  const zGrid = [], scGrid = [];
  for (let gy = 0; gy < gh; gy++) {
    const zRow = new Array(gw), scRow = new Array(gw);
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      for (let dy = 0; dy < step; dy++) {
        let i = ((gy * step + dy) * w + gx * step) * 4;
        for (let dx = 0; dx < step; dx++, i += 4) {
          sum += rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
        }
      }
      const elev = sum / (step * step);
      zRow[gx] = elev > 0 ? Math.round(elev) : 0;
      scRow[gx] = elev > 0 ? Math.round(elev) : WATER_SENTINEL;
    }
    zGrid.push(zRow); scGrid.push(scRow);
  }
  const lons = Array.from({ length: gw },
    (_, j) => bbox.lonMin + (bbox.lonMax - bbox.lonMin) * (j + 0.5) * step / w);
  const lats = Array.from({ length: gh },
    (_, i) => pxToLat(y0 * 256 + pxT + (i + 0.5) * step, z));
  return { lons, lats, z: zGrid, sc: scGrid, zoom: z };
}

function terrainTrace(terrain) {
  let zMax = 0;
  for (const row of terrain.z) for (const v of row) if (v > zMax) zMax = v;
  const cmax = Math.max(zMax, CMAX_FLOOR);
  const pos = e => (e - WATER_SENTINEL) / (cmax - WATER_SENTINEL);
  return {
    type: "surface",
    x: terrain.lons, y: terrain.lats, z: terrain.z,
    surfacecolor: terrain.sc,
    cmin: WATER_SENTINEL, cmax,
    colorscale: [
      [0, "#2e7bbf"], [pos(-30), "#2e7bbf"],        // water band (sentinel cells)
      [pos(0), "#33682f"],                           // shoreline lowlands
      [pos(cmax * 0.13), "#578443"],
      [pos(cmax * 0.30), "#96995a"],
      [pos(cmax * 0.50), "#9c7e55"],
      [pos(cmax * 0.70), "#8f8377"],
      [pos(cmax * 0.87), "#c2bfba"],
      [1, "#ffffff"],
    ],
    showscale: false, showlegend: false, name: "terrain",
    hovertemplate: "terrain %{z:.0f} m<extra></extra>",
    lighting: { ambient: 0.62, diffuse: 0.6, specular: 0.08, roughness: 0.85, fresnel: 0.2 },
    lightposition: { x: -400, y: 600, z: 1500 },
  };
}

// Nearest-cell terrain height, so markers/labels sit on the surface
function terrainHeightAt(terrain, lat, lon) {
  if (!terrain) return 0;
  const { lons, lats, z } = terrain;
  let j = lons.findIndex(v => v >= lon);
  if (j < 0) j = lons.length - 1;
  let i = lats.findIndex(v => v <= lat);   // lats descend north -> south
  if (i < 0) i = lats.length - 1;
  return z[i][j];
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

function airportsTrace(db, bbox, terrain) {
  const within = db.filter(a => a.la >= bbox.latMin && a.la <= bbox.latMax &&
                                a.lo >= bbox.lonMin && a.lo <= bbox.lonMax);
  if (!within.length) return { trace: null, count: 0 };
  const size = { large: 7, medium: 5, small: 4 };
  return {
    count: within.length,
    trace: {
      type: "scatter3d", mode: "markers+text", name: "Airports",
      x: within.map(a => a.lo),
      y: within.map(a => a.la),
      z: within.map(a => Math.max(a.e, terrainHeightAt(terrain, a.la, a.lo)) + 30),
      text: within.map(a => a.a || a.i),
      hovertext: within.map(a => `${a.n} (${a.i}${a.a ? "/" + a.a : ""})<br>elev ${a.e} m`),
      hoverinfo: "text",
      textposition: "top center",
      textfont: { color: "#ff8a8a", size: 11 },
      marker: { color: "#ff5c5c", size: within.map(a => size[a.t]), symbol: "diamond" },
      showlegend: false,
    },
  };
}

/* ---------------- Callsign labels (latest position per aircraft) ---------------- */

function labelsTrace(last) {
  return {
    type: "scatter3d", mode: "markers+text", name: "Callsigns",
    x: last.map(p => p.lon),
    y: last.map(p => p.lat),
    z: last.map(p => p.alt),
    text: last.map(p => p.label),
    hovertext: last.map(p =>
      `${p.label} (${p.hex})<br>last seen ${fmtTime(p.t)} UTC<br>alt ${Math.round(p.alt)} m`),
    hoverinfo: "text",
    textposition: "top center",
    textfont: { color: "#e6edf3", size: 10 },
    marker: { color: "#e6edf3", size: 2 },
    showlegend: false,
  };
}

/* ---------------- Render pipeline ---------------- */

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
  let dLat = Math.max((latMax - latMin) * BBOX_MARGIN, (MIN_SPAN_DEG - (latMax - latMin)) / 2, 0.02);
  let dLon = Math.max((lonMax - lonMin) * BBOX_MARGIN, (MIN_SPAN_DEG - (lonMax - lonMin)) / 2, 0.02);
  return {
    latMin: Math.max(latMin - dLat, -85), latMax: Math.min(latMax + dLat, 85),
    lonMin: Math.max(lonMin - dLon, -180), lonMax: Math.min(lonMax + dLon, 180),
  };
}

async function render(text, sourceName) {
  setStatus(`Parsing ${sourceName}…`);
  $("empty-hint").style.display = "none";
  try {
    const { aircraft, bad } = parseCSV(text);
    const { traces, last, total } = buildTrajectories(aircraft);
    const bbox = dataBbox(aircraft);

    const [terrainRes, airportsRes] = await Promise.allSettled([
      fetchTerrain(bbox, (d, n) => setStatus(`Fetching terrain tiles ${d}/${n}…`)),
      loadAirportsDb(),
    ]);
    const terrain = terrainRes.status === "fulfilled" ? terrainRes.value : null;
    const warnings = [];
    if (!terrain) warnings.push("terrain unavailable");

    const all = [];
    if (terrain) all.push(terrainTrace(terrain));
    all.push(...traces);

    traceIndex = {};
    let airportCount = 0;
    if (airportsRes.status === "fulfilled") {
      const { trace, count } = airportsTrace(airportsRes.value, bbox, terrain);
      if (trace) { traceIndex.airports = all.length; all.push(trace); airportCount = count; }
    } else {
      warnings.push("airport db unavailable");
    }
    traceIndex.labels = all.length;
    all.push(labelsTrace(last));

    // Horizontal axes proportional in km; altitude exaggerated via slider factor
    const latMid = (bbox.latMin + bbox.latMax) / 2;
    const kmX = (bbox.lonMax - bbox.lonMin) * 111.32 * Math.cos(latMid * Math.PI / 180);
    const kmY = (bbox.latMax - bbox.latMin) * 111.32;
    const ay = kmY / kmX;
    zAspectMax = Math.max(1, ay);
    const vscale = parseFloat($("vscale").value);

    const axis = (title, bg) => ({
      title, color: "#8b949e", gridcolor: "#21262d",
      zerolinecolor: "#30363d", backgroundcolor: bg,
    });
    await Plotly.newPlot(plotEl, all, {
      paper_bgcolor: "#0d1117",
      showlegend: true,
      legend: { font: { color: "#8b949e", size: 9 }, bgcolor: "rgba(13,17,23,0.6)",
                itemsizing: "constant" },
      margin: { l: 0, r: 0, t: 0, b: 0 },
      scene: {
        aspectmode: "manual",
        aspectratio: { x: 1, y: ay, z: vscale * zAspectMax },
        xaxis: axis("Longitude", "#0d1117"),
        yaxis: axis("Latitude", "#0d1117"),
        zaxis: axis("Altitude (m)", "#161b22"),
        camera: { eye: { x: 1.4, y: -1.6, z: 0.8 } },
      },
    }, { responsive: true, displaylogo: false });
    applyToggles();

    const days = new Set(last.map(p => new Date(p.t).toISOString().slice(0, 10)));
    const parts = [
      `${traces.length} aircraft`,
      `${total.toLocaleString()} points`,
      [...days].sort().join(", ") + " UTC",
      `${airportCount} airports`,
      terrain ? `terrain z${terrain.zoom}` : null,
      bad ? `${bad} rows skipped` : null,
      warnings.length ? `⚠ ${warnings.join(", ")}` : null,
    ].filter(Boolean);
    setStatus(parts.join(" | "), warnings.length > 0);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

/* ---------------- UI wiring ---------------- */

function applyToggles() {
  if (!plotEl.data) return;
  const updates = [];
  if (traceIndex.airports !== undefined)
    updates.push([traceIndex.airports, $("cb-airports").checked]);
  if (traceIndex.labels !== undefined)
    updates.push([traceIndex.labels, $("cb-callsigns").checked]);
  for (const [idx, on] of updates)
    Plotly.restyle(plotEl, { visible: on ? true : "legendonly" }, [idx]);
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
  setStatus("Loading sample…");
  try {
    const resp = await fetch("data/sample.csv");
    if (!resp.ok) throw new Error(`sample.csv: HTTP ${resp.status}`);
    render(await resp.text(), "sample.csv");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
});

$("cb-callsigns").addEventListener("change", applyToggles);
$("cb-airports").addEventListener("change", applyToggles);

$("vscale").addEventListener("input", () => {
  const v = parseFloat($("vscale").value);
  $("vscale-val").textContent = v.toFixed(2);
  if (plotEl.data) Plotly.relayout(plotEl, { "scene.aspectratio.z": v * zAspectMax });
});

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
