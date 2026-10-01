#!/usr/bin/env python3
"""Build the app's data files in docs/data/ from the committed sources in data/sources/.

    python3 tools/build_data.py                      # rebuild docs/data from data/sources
    python3 tools/build_data.py --pubgen ../Pub_gen  # also refresh data/sources/venues.json

Outputs (plain scripts, so the site works from file:// and needs no fetch):

    docs/data/network.js   rail network: lines, stations, track segments, interchanges
    docs/data/venues.js    pubs, parks, museums, galleries, markets, theatres
    docs/data/places.js    postcode districts/sectors and boroughs, for search
    docs/data/basemap.js   borough outlines and the Thames, drawn when map tiles can't load
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "data" / "sources"
OUT = ROOT / "docs" / "data"
YEAR = 2026

# name -> (colour, mode, top speed km/h, dwell+accel minutes, average wait minutes)
LINES = {
    "Bakerloo": ("#B36305", "tube", 45, 0.9, 2.5),
    "Central": ("#E32017", "tube", 55, 0.9, 2.0),
    "Circle": ("#FFD300", "tube", 40, 0.9, 4.0),
    "District": ("#00782A", "tube", 45, 0.9, 3.0),
    "Hammersmith & City": ("#F3A9BB", "tube", 40, 0.9, 4.0),
    "Jubilee": ("#A0A5A9", "tube", 60, 0.9, 2.0),
    "Metropolitan": ("#9B0056", "tube", 65, 0.9, 3.5),
    "Northern": ("#000000", "tube", 50, 0.9, 2.0),
    "Piccadilly": ("#003688", "tube", 55, 0.9, 2.5),
    "Victoria": ("#0098D4", "tube", 55, 0.8, 1.5),
    "Waterloo & City": ("#95CDBA", "tube", 50, 0.5, 3.0),
    "DLR": ("#00A4A7", "dlr", 45, 0.8, 3.0),
    "Elizabeth line": ("#6950A1", "elizabeth-line", 85, 1.0, 3.0),
    "Liberty": ("#676A6D", "overground", 60, 1.0, 15.0),
    "Lioness": ("#F1B41C", "overground", 60, 1.0, 5.0),
    "Mildmay": ("#2E7DC1", "overground", 55, 1.0, 4.0),
    "Suffragette": ("#2EAD5D", "overground", 55, 1.0, 6.0),
    "Weaver": ("#8C2A52", "overground", 60, 1.0, 6.0),
    "Windrush": ("#E2403A", "overground", 55, 1.0, 4.0),
    "London Overground": ("#EE7C0E", "overground", 55, 1.0, 6.0),
    "Tram": ("#84B817", "tram", 30, 0.6, 4.0),
    "IFS Cloud Cable Car": ("#E21836", "cable-car", 18, 0.0, 3.0),
    "National Rail": ("#5B6770", "national-rail", 65, 1.5, 6.0),
}
RENAME = {"Tramlink": "Tram"}
DROP_LINES = {"Crossrail 2", "East London", "Thameslink 6tph line"}

# Main National Rail corridors, as chains of stops that exist in the station data.
RAIL_CHAINS = [
    "Waterloo|Vauxhall|Clapham Junction|Wimbledon",
    "Clapham Junction|Richmond",
    "Victoria|Battersea Park|Clapham Junction|East Croydon",
    "Victoria|Brixton",
    "Victoria|Denmark Hill|Peckham Rye",
    "London Bridge|Queens Road Peckham|Peckham Rye",
    "Blackfriars|Elephant & Castle|Denmark Hill|Peckham Rye",
    "Clapham Junction|Balham",
    "Charing Cross|Waterloo|London Bridge",
    "Cannon Street|London Bridge",
    "London Bridge|East Croydon",
    "London Bridge|New Cross|Lewisham",
    "London Bridge|Greenwich|Woolwich Arsenal",
    "London Bridge|Blackfriars|City Thameslink|Farringdon|St. Pancras International|Kentish Town|West Hampstead Thameslink",
    "Moorgate|Old Street|Highbury & Islington|Finsbury Park",
    "King's Cross St. Pancras|Finsbury Park",
    "Liverpool Street|Hackney Downs|Tottenham Hale",
    "Limehouse|West Ham|Barking|Upminster",
    "Euston|Wembley Central|Harrow & Wealdstone|Watford Junction",
    "Marylebone|South Ruislip",
    "St. Pancras International|Stratford International",
]

# The six Overground lines named in 2024, by the stations each one calls at.
OVERGROUND = {
    "Lioness": "Euston|South Hampstead|Kilburn High Road|Queen's Park|Kensal Green|Willesden Junction|Harlesden|"
    "Stonebridge Park|Wembley Central|North Wembley|South Kenton|Kenton|Harrow & Wealdstone|Headstone Lane|"
    "Hatch End|Carpenders Park|Bushey|Watford High Street|Watford Junction",
    "Mildmay": "Stratford|Hackney Wick|Homerton|Hackney Central|Dalston Kingsland|Canonbury|Highbury & Islington|"
    "Caledonian Road & Barnsbury|Camden Road|Kentish Town West|Gospel Oak|Hampstead Heath|Finchley Road & Frognal|"
    "West Hampstead|Brondesbury|Brondesbury Park|Kensal Rise|Willesden Junction|Acton Central|South Acton|"
    "Gunnersbury|Kew Gardens|Richmond|Shepherd's Bush|Kensington (Olympia)|West Brompton|Imperial Wharf|"
    "Clapham Junction",
    "Suffragette": "Gospel Oak|Upper Holloway|Crouch Hill|Harringay Green Lanes|South Tottenham|Blackhorse Road|"
    "Walthamstow Queens Road|Leyton Midland Road|Leytonstone High Road|Wanstead Park|Woodgrange Park|Barking|"
    "Barking Riverside",
    "Weaver": "Liverpool Street|Bethnal Green|Cambridge Heath|London Fields|Hackney Downs|Rectory Road|"
    "Stoke Newington|Stamford Hill|Seven Sisters|Bruce Grove|White Hart Lane|Silver Street|Edmonton Green|"
    "Bush Hill Park|Enfield Town|Southbury|Turkey Street|Theobalds Grove|Cheshunt|Clapton|St James Street|"
    "Walthamstow Central|Wood Street|Highams Park|Chingford",
    "Windrush": "Highbury & Islington|Canonbury|Dalston Junction|Haggerston|Hoxton|Shoreditch High Street|"
    "Whitechapel|Shadwell|Wapping|Rotherhithe|Canada Water|Surrey Quays|New Cross|Queens Road Peckham|Peckham Rye|"
    "Denmark Hill|Clapham High Street|Wandsworth Road|Clapham Junction|New Cross Gate|Brockley|Honor Oak Park|"
    "Forest Hill|Sydenham|Crystal Palace|Penge West|Anerley|Norwood Junction|West Croydon",
    "Liberty": "Romford|Emerson Park|Upminster",
}
OVERGROUND = {line: set(names.split("|")) for line, names in OVERGROUND.items()}

NORTH_BANK = {"Hounslow", "Hammersmith and Fulham", "Kensington and Chelsea", "Westminster", "City of London",
              "Tower Hamlets", "Newham", "Barking and Dagenham", "Havering"}
SOUTH_BANK = {"Richmond upon Thames", "Wandsworth", "Lambeth", "Southwark", "Lewisham", "Greenwich", "Bexley",
              "Kingston upon Thames"}


# ---------------------------------------------------------------- geometry helpers

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def line_length(coords: list[tuple[float, float]]) -> float:
    """coords are (lat, lon)."""
    return sum(haversine(*coords[i], *coords[i + 1]) for i in range(len(coords) - 1))


def simplify(coords: list[tuple[float, float]], tolerance_m: float) -> list[tuple[float, float]]:
    """Douglas-Peucker on (lat, lon) using a local equirectangular projection."""
    if len(coords) < 3:
        return coords
    lat0 = math.radians(coords[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    pts = [(lon * kx, lat * ky) for lat, lon in coords]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if seg2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, best_i = d, i
        if best > tolerance_m:
            keep[best_i] = True
            stack += [(a, best_i), (best_i, b)]
    return [c for c, k in zip(coords, keep) if k]


def encode_polyline(coords: list[tuple[float, float]], precision: int = 5) -> str:
    """Google encoded polyline (lat, lon)."""
    factor = 10 ** precision
    out, prev_lat, prev_lon = [], 0, 0
    for lat, lon in coords:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


# ---------------------------------------------------------------- network

def current(entry: dict) -> bool:
    opened, closed = entry.get("opened"), entry.get("closed")
    if opened is not None and opened > YEAR:
        return False
    if closed is not None and closed <= YEAR:
        return False
    return True


def base_name(name: str) -> str:
    """'Highbury & Islington (Rail)' -> 'Highbury & Islington'; keeps '(Olympia)' and similar."""
    name = re.sub(r"\s*\((Rail|DLR[^)]*|Tram|Bakerloo|Circle|District|H&C|Dist&Pic|Circle Line|Elizabeth line)\)\s*$",
                  "", name).strip()
    return name.replace("St.Albans", "St Albans")


def build_network() -> dict:
    stations_raw = json.loads((SOURCES / "tfl_stations.json").read_text())["features"]
    lines_raw = json.loads((SOURCES / "tfl_lines.json").read_text())["features"]

    # Stations with at least one current line, merged by name when they are the same complex.
    stations: list[dict] = []
    for feature in stations_raw:
        props = feature["properties"]
        lines = set()
        for entry in props.get("lines", []):
            name = RENAME.get(entry["name"], entry["name"])
            if name in DROP_LINES or not current(entry):
                continue
            lines.add(name)
        if not lines:
            continue
        lon, lat = feature["geometry"]["coordinates"][:2]
        name = base_name(props["name"])
        zone = str(props.get("zone", "") or "")
        merged = False
        for st in stations:
            if st["name"] == name and haversine(st["lat"], st["lon"], lat, lon) < 320:
                st["lines"] |= lines
                st["zone"] = st["zone"] or zone
                merged = True
                break
        if not merged:
            stations.append({"name": name, "lat": lat, "lon": lon, "zone": zone, "lines": lines})

    def serves(st: dict, line: str) -> bool:
        if line in st["lines"]:
            return True
        if LINES[line][1] == "overground":
            return "London Overground" in st["lines"]
        if line == "National Rail":
            return True
        return False

    junctions: list[dict] = []

    def snap(lat: float, lon: float, line: str) -> int:
        best, best_d = None, 1e9
        for i, st in enumerate(stations):
            d = haversine(lat, lon, st["lat"], st["lon"])
            if d < best_d and serves(st, line):
                best, best_d = i, d
        if best is not None and best_d < 260:
            return best
        for i, st in enumerate(stations):
            if haversine(lat, lon, st["lat"], st["lon"]) < 120:
                return i
        for j, jn in enumerate(junctions):
            if haversine(lat, lon, jn["lat"], jn["lon"]) < 25:
                return len(stations) + j  # provisional index, fixed up below
        junctions.append({"lat": lat, "lon": lon})
        return len(stations) + len(junctions) - 1

    def split_at_stations(coords: list[tuple[float, float]], line: str) -> list[list[tuple[float, float]]]:
        """Long track sections (the Elizabeth line core, for one) pass through stations: cut them there."""
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        lat0 = math.radians(sum(lats) / len(lats))
        kx, ky = 111320 * math.cos(lat0), 110540
        xy = [(lon * kx, lat * ky) for lat, lon in coords]
        cuts = []  # (vertex index, t, projected point)
        for st in stations:
            if not serves(st, line):
                continue
            if not (min(lats) - 0.003 < st["lat"] < max(lats) + 0.003 and min(lons) - 0.005 < st["lon"] < max(lons) + 0.005):
                continue
            px, py = st["lon"] * kx, st["lat"] * ky
            best = (1e9, 0, 0.0)
            for i in range(len(xy) - 1):
                (ax, ay), (bx, by) = xy[i], xy[i + 1]
                dx, dy = bx - ax, by - ay
                seg2 = dx * dx + dy * dy or 1e-9
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
                if d < best[0]:
                    best = (d, i, t)
            d, i, t = best
            if d > 150:
                continue
            lat = coords[i][0] + t * (coords[i + 1][0] - coords[i][0])
            lon = coords[i][1] + t * (coords[i + 1][1] - coords[i][1])
            if min(haversine(lat, lon, *coords[0]), haversine(lat, lon, *coords[-1])) < 200:
                continue
            cuts.append((i, t, (lat, lon)))
        if not cuts:
            return [coords]
        cuts.sort()
        pieces, current_piece, start = [], [coords[0]], 0
        for i, _, point in cuts:
            current_piece += coords[start + 1:i + 1] + [point]
            pieces.append(current_piece)
            current_piece, start = [point], i
        current_piece += coords[start + 1:]
        pieces.append(current_piece)
        return [p for p in pieces if len(p) >= 2]

    segments = []  # (a, b, line, coords)
    for feature in lines_raw:
        raw = [(c[1], c[0]) for c in feature["geometry"]["coordinates"]]
        if len(raw) < 2:
            continue
        for entry in feature["properties"].get("lines", []):
            name = RENAME.get(entry["name"], entry["name"])
            if name in DROP_LINES or not current(entry) or name not in LINES:
                continue
            for coords in split_at_stations(raw, name):
                a = snap(*coords[0], name)
                b = snap(*coords[-1], name)
                if a == b:
                    continue
                segments.append([a, b, name, coords])

    # National Rail: the source has no current tracks, so add the main corridors as straight links.
    by_name: dict[str, int] = {}
    for i, st in enumerate(stations):
        by_name.setdefault(st["name"], i)
    for chain in RAIL_CHAINS:
        names = chain.split("|")
        for n1, n2 in zip(names, names[1:]):
            if n1 not in by_name or n2 not in by_name:
                print(f"  rail link skipped: {n1} - {n2}")
                continue
            a, b = by_name[n1], by_name[n2]
            s1, s2 = stations[a], stations[b]
            segments.append([a, b, "National Rail", [(s1["lat"], s1["lon"]), (s2["lat"], s2["lon"])]])

    # Give Overground segments their 2024 line names.
    def og_candidates(idx: int) -> set[str] | None:
        if idx >= len(stations):
            return None
        name = stations[idx]["name"]
        return {line for line, names in OVERGROUND.items() if name in names}

    unresolved = []
    for seg in segments:
        if seg[2] != "London Overground":
            continue
        ca, cb = og_candidates(seg[0]), og_candidates(seg[1])
        if ca is not None and cb is not None:
            cand = ca & cb
        else:
            cand = ca if ca is not None else cb
        seg.append(cand or set())
        if not cand:
            unresolved.append(seg)
    for _ in range(6):  # spread names across junction-to-junction pieces
        for seg in unresolved:
            if seg[4]:
                continue
            near = set()
            for other in segments:
                if other is seg or other[2] != "London Overground" or not other[4]:
                    continue
                if {seg[0], seg[1]} & {other[0], other[1]}:
                    near |= other[4]
            seg[4] = near
    expanded = []
    for seg in segments:
        if seg[2] == "London Overground":
            for line in sorted(seg[4]) or ["London Overground"]:
                expanded.append((seg[0], seg[1], line, seg[3]))
        else:
            expanded.append(tuple(seg[:4]))

    # Station line lists follow the segments actually touching them.
    for st in stations:
        st["lines"] = set()
    for a, b, line, _ in expanded:
        for idx in (a, b):
            if idx < len(stations):
                stations[idx]["lines"].add(line)

    # Close small gaps: a junction that dead-ends on a line joins the nearest stop on that line.
    def node_pos(idx: int) -> tuple[float, float]:
        n = stations[idx] if idx < len(stations) else junctions[idx - len(stations)]
        return n["lat"], n["lon"]

    degree = defaultdict(int)
    linked = defaultdict(set)
    for a, b, line, _ in expanded:
        degree[(a, line)] += 1
        degree[(b, line)] += 1
        linked[(a, line)].add(b)
        linked[(b, line)].add(a)
    for (node, line), deg in list(degree.items()):
        if deg != 1 or node < len(stations):
            continue
        lat, lon = node_pos(node)
        best, best_d = None, 650.0
        for i, st in enumerate(stations):
            if line in st["lines"] and i not in linked[(node, line)]:
                d = haversine(lat, lon, st["lat"], st["lon"])
                if d < best_d:
                    best, best_d = i, d
        if best is not None:
            expanded.append((node, best, line, [(lat, lon), node_pos(best)]))

    line_names = [name for name in LINES if any(seg[2] == name for seg in expanded)]
    line_index = {name: i for i, name in enumerate(line_names)}

    # Deduplicate identical (a, b, line) segments, keep the shorter geometry.
    seen: dict[tuple, tuple] = {}
    for a, b, line, coords in expanded:
        key = (min(a, b), max(a, b), line)
        if a > b:
            coords = coords[::-1]
        length = line_length(coords)
        if key not in seen or length < seen[key][0]:
            seen[key] = (length, coords)

    # Shared geometries: identical track carries several lines; store each shape once.
    geoms: list[str] = []
    geom_index: dict[str, int] = {}
    edges = []
    for (a, b, line), (length, coords) in sorted(seen.items()):
        enc = encode_polyline(simplify(coords, 6))
        if enc not in geom_index:
            geom_index[enc] = len(geoms)
            geoms.append(enc)
        edges.append([a, b, line_index[line], round(length), geom_index[enc]])

    # Walking interchanges between separate stations (Bank-Monument, Euston-Euston Square...).
    transfers = []
    for i, s1 in enumerate(stations):
        for j in range(i + 1, len(stations)):
            s2 = stations[j]
            d = haversine(s1["lat"], s1["lon"], s2["lat"], s2["lon"])
            if d < 420:
                transfers.append([i, j, round(d)])

    nodes = [
        [st["name"], round(st["lat"], 5), round(st["lon"], 5), st["zone"],
         sorted(line_index[l] for l in st["lines"] if l in line_index)]
        for st in stations
    ] + [["", round(j["lat"], 5), round(j["lon"], 5), "", []] for j in junctions]

    # Report connectivity per line (a broken line usually means a snapping problem).
    report = {}
    for name in line_names:
        li = line_index[name]
        adj = defaultdict(set)
        for a, b, l, _, _ in edges:
            if l == li:
                adj[a].add(b)
                adj[b].add(a)
        seen_nodes, comps = set(), 0
        for start in adj:
            if start in seen_nodes:
                continue
            comps += 1
            stack = [start]
            while stack:
                n = stack.pop()
                if n in seen_nodes:
                    continue
                seen_nodes.add(n)
                stack.extend(adj[n] - seen_nodes)
        report[name] = (len([n for n in adj if n < len(stations)]), comps)

    return {
        "lines": [[n, LINES[n][0], LINES[n][1], LINES[n][2], LINES[n][3], LINES[n][4]] for n in line_names],
        "stationCount": len(stations),
        "nodes": nodes,
        "edges": edges,
        "geoms": geoms,
        "transfers": transfers,
        "_report": report,
    }


# ---------------------------------------------------------------- venues

PUB_FOOD, PUB_ALE, PUB_OUTDOOR, PUB_STEPFREE, PUB_DOG, PUB_HISTORIC, PUB_CHAIN, PUB_MUSIC = (1 << i for i in range(8))
CLOSED = re.compile(r"\((closed|former|disused|demolished)\)|\bclosed\b|\bformerly\b", re.I)


def yes(value: str) -> bool:
    return str(value or "").strip().lower() not in ("", "no", "none", "0", "false")


def short_address(props: dict, tags: dict) -> str:
    number = tags.get("addr:housenumber", "")
    street = tags.get("addr:street", "")
    postcode = tags.get("addr:postcode", "")
    if street:
        text = f"{number} {street}".strip()
        return f"{text}, {postcode}" if postcode else text
    addr = " ".join(str(props.get("address") or "").split())
    addr = re.sub(r",\s*London\b", "", addr)
    return addr[:60]


def clean_url(url: str) -> str:
    url = (url or "").split(";")[0].strip()
    return url if re.match(r"^https?://", url) and len(url) < 120 else ""


def venues_from_pubgen(pubgen: Path) -> list:
    rows = []
    pubs = json.loads((pubgen / "v2" / "data" / "london_pubs.geojson").read_text())["features"]
    for f in pubs:
        p = f["properties"]
        t = p.get("tags") or {}
        name = " ".join(str(p.get("name") or "").split())
        if not name or CLOSED.search(name) or str(t.get("opening_hours", "")).lower() == "closed":
            continue
        if any(k.startswith(("disused:", "abandoned:", "was:")) or k == "end_date" for k in t):
            continue
        flags = 0
        if yes(p.get("food")) or (p.get("cuisine") and str(p.get("food")).lower() != "no"):
            flags |= PUB_FOOD
        if yes(p.get("real_ale")):
            flags |= PUB_ALE
        if yes(p.get("outdoor_seating")) or t.get("beer_garden") == "yes":
            flags |= PUB_OUTDOOR
        if str(p.get("wheelchair", "")).lower() in ("yes", "designated"):
            flags |= PUB_STEPFREE
        if str(p.get("dog", "")).lower() in ("yes", "leashed", "outside"):
            flags |= PUB_DOG
        if t.get("heritage") or t.get("listed_status") or t.get("wikipedia") or t.get("historic"):
            flags |= PUB_HISTORIC
        if t.get("brand") or t.get("brand:wikidata"):
            flags |= PUB_CHAIN
        if yes(p.get("live_music")):
            flags |= PUB_MUSIC
        q = 4 + 2 * bool(flags & PUB_HISTORIC) + bool(flags & PUB_ALE) + bool(flags & PUB_OUTDOOR) \
            + bool(t.get("wikidata")) + bool(t.get("microbrewery") == "yes") - 2 * bool(flags & PUB_CHAIN)
        lon, lat = f["geometry"]["coordinates"][:2]
        rows.append(["pub", name, round(lat, 5), round(lon, 5), max(0, min(9, q)), flags,
                     short_address(p, t), clean_url(p.get("website") or t.get("website") or "")])

    pois = json.loads((pubgen / "v2" / "data" / "london_pois.geojson").read_text())["features"]
    for f in pois:
        p = f["properties"]
        t = p.get("tags") or {}
        kind = None
        if t.get("leisure") in ("park", "nature_reserve") or t.get("historic") == "park":
            kind = "park"
        elif t.get("leisure") == "garden" and t.get("garden:type") != "private" and t.get("access") not in ("private", "no"):
            kind = "park"
        elif t.get("tourism") == "museum":
            kind = "museum"
        elif t.get("tourism") == "gallery" or t.get("amenity") == "arts_centre":
            kind = "gallery"
        elif t.get("amenity") == "marketplace" or t.get("shop") == "market":
            kind = "market"
        elif t.get("amenity") == "theatre":
            kind = "theatre"
        if not kind:
            continue
        name = " ".join(str(p.get("title") or t.get("name") or "").split())
        if not name or re.fullmatch(r"[\d\s./:#-]+", name) or CLOSED.search(name):
            continue
        score = int(p.get("interest_score") or 0)
        notable = bool(p.get("wikipedia") or p.get("wikidata") or t.get("heritage") or t.get("listed_status"))
        q = (score - 25) / 9 + 2 * notable
        if kind == "park" and re.search(r"\b(green|square|gardens?)\b", name, re.I) and not notable:
            q -= 1
        lon, lat = f["geometry"]["coordinates"][:2]
        rows.append([kind, name, round(lat, 5), round(lon, 5), max(0, min(9, round(q))), 0,
                     short_address(p, t), clean_url(p.get("website") or "")])

    # Same place mapped twice (node + way): keep the higher quality one.
    best: dict[tuple, list] = {}
    for row in rows:
        key = (row[0], row[1].casefold(), round(row[2], 3), round(row[3], 3))
        if key not in best or row[4] > best[key][4]:
            best[key] = row
    return sorted(best.values(), key=lambda r: (r[0], r[1].casefold()))


# ---------------------------------------------------------------- places and basemap

def ring_list(geometry: dict) -> list:
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return [ring for poly in polys for ring in poly]


def build_places_and_basemap() -> tuple[dict, dict]:
    boroughs = json.loads((SOURCES / "london_boroughs.geojson").read_text())["features"]
    outlines, centroids = [], []
    for f in boroughs:
        rings = ring_list(f["geometry"])
        name = f["properties"]["name"]
        enc = []
        for ring in rings:
            coords = [(c[1], c[0]) for c in ring]
            enc.append(encode_polyline(simplify(coords, 35), 4))
        outlines.append([name, enc])
        outer = max(rings, key=len)
        lat = sum(c[1] for c in outer) / len(outer)
        lon = sum(c[0] for c in outer) / len(outer)
        centroids.append([name, round(lat, 4), round(lon, 4)])

    # The Thames: borough polygons stop at the river bank, so the river is the gap between
    # north-bank and south-bank boroughs. Draw its centre line (midway across the gap).
    def rings_of(names: set[str]) -> list[list[tuple[float, float]]]:
        return [[(c[1], c[0]) for c in ring] for f in boroughs if f["properties"]["name"] in names
                for ring in ring_list(f["geometry"])]

    south_pts = [p for ring in rings_of(SOUTH_BANK) for p in ring]
    grid = defaultdict(list)
    for lat, lon in south_pts:
        grid[(round(lat * 400), round(lon * 250))].append((lat, lon))

    def across(lat: float, lon: float) -> tuple[float, float] | None:
        """Midpoint to the nearest south-bank vertex if it is across water (not a shared land edge)."""
        gy, gx = round(lat * 400), round(lon * 250)
        best, best_d = None, 1e9
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                for p in grid.get((gy + dy, gx + dx), ()):
                    d = haversine(lat, lon, *p)
                    if d < best_d:
                        best, best_d = p, d
        if best is None or not (35 < best_d < 750):
            return None
        return ((lat + best[0]) / 2, (lon + best[1]) / 2)

    river = []
    for ring in rings_of(NORTH_BANK):
        run = []
        for pt in ring:
            mid = across(*pt)
            if mid:
                run.append(mid)
            else:
                if len(run) >= 2:
                    river.append(run)
                run = []
        if len(run) >= 2:
            river.append(run)
    river_enc = [encode_polyline(simplify(run, 15), 4) for run in river if line_length(run) > 400]

    postcodes = []
    with (SOURCES / "london_postcodes.csv").open() as fh:
        for row in csv.DictReader(fh):
            postcodes.append([row["code"], float(row["lat"]), float(row["lon"])])

    places = {"postcodes": postcodes, "boroughs": sorted(centroids)}
    basemap = {"boroughs": outlines, "thames": river_enc}
    return places, basemap


# ---------------------------------------------------------------- main

def write_js(name: str, var: str, payload: dict) -> int:
    text = f"window.{var}=" + json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + ";\n"
    (OUT / name).write_text(text, encoding="utf-8")
    return len(text.encode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pubgen", type=Path, help="path to a Pub_gen checkout, to refresh data/sources/venues.json")
    args = parser.parse_args()

    if args.pubgen:
        venues = venues_from_pubgen(args.pubgen)
        (SOURCES / "venues.json").write_text(
            "[\n" + ",\n".join(json.dumps(r, ensure_ascii=False) for r in venues) + "\n]\n", encoding="utf-8")
        print(f"venues.json: {len(venues)} venues from {args.pubgen}")

    OUT.mkdir(parents=True, exist_ok=True)
    net = build_network()
    report = net.pop("_report")
    for line, (stations, comps) in report.items():
        flag = "" if comps == 1 else f"  <- {comps} pieces"
        print(f"  {line:22s} {stations:3d} stations{flag}")
    size = write_js("network.js", "HH_NET", net)
    print(f"network.js: {net['stationCount']} stations, {len(net['edges'])} track segments, "
          f"{len(net['transfers'])} walking interchanges, {size // 1024} KB")

    venues = json.loads((SOURCES / "venues.json").read_text())
    counts = defaultdict(int)
    for row in venues:
        counts[row[0]] += 1
    size = write_js("venues.js", "HH_VENUES", {"rows": venues})
    print(f"venues.js: {dict(counts)}, {size // 1024} KB")

    places, basemap = build_places_and_basemap()
    size = write_js("places.js", "HH_PLACES", places)
    print(f"places.js: {len(places['postcodes'])} postcodes, {len(places['boroughs'])} boroughs, {size // 1024} KB")
    size = write_js("basemap.js", "HH_BASEMAP", basemap)
    print(f"basemap.js: {len(basemap['thames'])} river pieces, {size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
