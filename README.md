# ADS-B 3D Trajectory Viewer

A self-contained web app that renders dump1090 ADS-B CSV logs as interactive 3D
flight trajectories over real terrain, with airports and aircraft callsigns
labeled.

**Live demo:** <https://icthieves.github.io/adsb-viewer/> — click **Load sample**
for a day of Vancouver-area traffic.

- **Trajectories** — one colored line per aircraft (legend toggles each; double-click
  a legend entry to isolate it). Lines break across signal gaps longer than 10 minutes.
- **Terrain** — elevation fetched on the fly from the
  [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset
  (terrarium PNG encoding) for the data's bounding box, rendered as a shaded relief
  surface with water in blue. Zoom level adapts to the size of the area.
- **Airports** — every airport from the bundled [OurAirports](https://ourairports.com/data/)
  extract that falls inside the bounding box is marked with a red diamond and its
  IATA/ICAO code (large + medium airports worldwide, plus small fields with scheduled service).
- **Callsign labels** — each aircraft's most recent position is labeled with its
  callsign (falling back to the hex ID if no callsign was broadcast).
- **Controls** — checkboxes toggle the airport and callsign labels; the slider sets
  vertical exaggeration of the altitude axis.

## Running

Any static file server works. From this folder:

```
python -m http.server 8000
```

then open <http://localhost:8000>. Internet access is required at runtime for the
Plotly.js CDN and the terrain tiles.

Click **Load sample** for a bundled day of Vancouver-area traffic (2017-06-28),
or drop your own CSV anywhere on the page.

## CSV format

The parser matches header names case-insensitively and ignores extra columns.
It needs:

| Field     | Accepted header names (substring match)        |
|-----------|------------------------------------------------|
| ICAO hex  | `hex_ident`, `icao`, `icao24`                  |
| Latitude  | `latitude`, `lat`                              |
| Longitude | `longitude`, `lon`, `lng`                      |
| Altitude  | `altitude`, `alt`                              |
| Timestamp | `timestamp`/`datetime`, **or** `date` + `time` |
| Callsign  | `callsign`, `flight` (optional)                |
| Speed     | `ground_speed`, `speed`, `gs` (optional)       |

Units: altitude is treated as **feet** (dump1090/SBS convention) unless the header
mentions meters (e.g. `altitude(meter)`); speed is treated as knots unless the
header mentions km. Rows with unparseable or out-of-range values are skipped and
counted in the status bar.

## Updating the airport database

`data/airports.json` is generated from the public-domain OurAirports dataset:

```
python tools/build_airports.py
```

## Data sources

- Terrain: Mapzen/AWS Terrain Tiles (terrarium), sources include SRTM, GMTED, ETOPO1.
- Airports: OurAirports (public domain).
- Plotly.js (MIT) via CDN.
