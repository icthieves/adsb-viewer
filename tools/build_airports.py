"""Build data/airports.json from the OurAirports public-domain dataset.

Keeps large airports, medium airports, and anything with scheduled service
(catches city seaplane bases and small fields with airline traffic).
Run from anywhere: python tools/build_airports.py
"""
import csv
import io
import json
import pathlib
import urllib.request

URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "airports.json"

TYPE_MAP = {"large_airport": "large", "medium_airport": "medium"}

with urllib.request.urlopen(URL, timeout=60) as resp:
    text = resp.read().decode("utf-8")

airports = []
for row in csv.DictReader(io.StringIO(text)):
    kind = TYPE_MAP.get(row["type"])
    if kind is None:
        if row["scheduled_service"] == "yes":
            kind = "small"
        else:
            continue
    try:
        lat = round(float(row["latitude_deg"]), 4)
        lon = round(float(row["longitude_deg"]), 4)
    except ValueError:
        continue
    elev_ft = row["elevation_ft"].strip()
    airports.append({
        "i": row["ident"],                      # ICAO / GPS ident
        "a": row["iata_code"].strip(),          # IATA (may be empty)
        "n": row["name"],
        "t": kind,
        "la": lat,
        "lo": lon,
        "e": round(float(elev_ft) * 0.3048) if elev_ft else 0,  # meters
    })

OUT.write_text(json.dumps(airports, separators=(",", ":")), encoding="utf-8")
print(f"{len(airports)} airports -> {OUT} ({OUT.stat().st_size/1024:.0f} KB)")
