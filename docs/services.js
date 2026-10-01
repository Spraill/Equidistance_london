/*
 * Network helpers: place search, TfL journeys and live venue lookups.
 * Everything here degrades gracefully: when a service can't be reached the app keeps working
 * from the bundled data and its own journey estimates.
 */
(function () {
  "use strict";
  const CFG = window.HH_CONFIG || {};
  const NET = window.HH_NET;
  const PLACES = window.HH_PLACES || { postcodes: [], boroughs: [] };

  // ---------------------------------------------------------------- local search

  const norm = (s) => String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/\bst\.?\s/g, "st ").replace(/\bsaint\b/g, "st")
    .replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  const MODE_WORD = { tube: "Underground", "elizabeth-line": "Elizabeth line", overground: "Overground", dlr: "DLR", tram: "Tram", "national-rail": "Rail", "cable-car": "Cable car" };

  let index = null;
  function buildIndex() {
    const out = [];
    const stationCount = NET.stationCount;
    for (let i = 0; i < stationCount; i++) {
      const [name, lat, lon, zone, ls] = NET.nodes[i];
      if (!name || !ls.length) continue;
      const modes = [...new Set(ls.map((l) => NET.lines[l][2]))].map((m) => MODE_WORD[m] || m);
      out.push({ kind: "station", label: name, sub: `Station · ${modes.join(", ")}${zone ? ` · Zone ${zone}` : ""}`, lat, lon, key: norm(name), rank: 3 });
    }
    for (const [name, lat, lon] of PLACES.boroughs) {
      out.push({ kind: "area", label: name, sub: "London borough", lat, lon, key: norm(name), rank: 2 });
    }
    for (const [code, lat, lon] of PLACES.postcodes) {
      out.push({ kind: "postcode", label: code, sub: code.includes(" ") ? "Postcode sector" : "Postcode district", lat, lon, key: norm(code), rank: 1 });
    }
    const TYPE_WORD = { pub: "Pub", park: "Park", museum: "Museum", gallery: "Gallery", market: "Market", theatre: "Theatre" };
    for (const [type, name, lat, lon, q, , address] of (window.HH_VENUES || { rows: [] }).rows) {
      out.push({ kind: "venue", label: name, sub: [TYPE_WORD[type], address].filter(Boolean).join(" · "), lat, lon, key: norm(name), rank: 0.5 + q / 20 });
    }
    return out;
  }

  const POSTCODE_FULL = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;

  function parseLatLon(q) {
    const m = String(q).trim().match(/^(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)$/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (lat < 51.2 || lat > 51.8 || lon < -0.6 || lon > 0.4) return null;
    return { kind: "coords", label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, sub: "Coordinates", lat, lon };
  }

  function searchLocal(query, limit) {
    if (!index) index = buildIndex();
    const q = norm(query);
    if (!q) return [];
    const coords = parseLatLon(query);
    if (coords) return [coords];
    const pc = String(query).trim().toUpperCase().replace(/\s+/g, " ");
    const scored = [];
    for (const item of index) {
      let s = 0;
      if (item.key === q) s = 100;
      else if (item.key.startsWith(q)) s = 60 - Math.min(20, item.key.length - q.length) / 2;
      else if (q.length >= 3 && (" " + item.key).includes(" " + q)) s = 40;
      else if (q.length >= 4 && item.key.includes(q)) s = 20;
      if (item.kind === "postcode" && !(pc.startsWith(item.label) || item.label.startsWith(pc))) s = 0;
      if (item.kind === "venue" && q.length < 3) s = 0;
      if (s) scored.push({ item, s: s + item.rank * 4 });
    }
    scored.sort((a, b) => b.s - a.s);
    const seen = new Set();
    const out = [];
    for (const { item } of scored) {
      const k = item.label + "|" + item.kind;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
      if (out.length >= (limit || 7)) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- remote search

  async function fetchJson(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 9000);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts && opts.init));
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupPostcode(query) {
    const m = String(query).trim().match(POSTCODE_FULL);
    if (!m) return null;
    const pc = `${m[1]} ${m[2]}`.toUpperCase();
    try {
      const data = await fetchJson(CFG.postcodesUrl + encodeURIComponent(pc), { timeout: 6000 });
      const r = data && data.result;
      if (r && r.latitude) return { kind: "postcode", label: pc, sub: [r.admin_ward, r.admin_district].filter(Boolean).join(", "), lat: r.latitude, lon: r.longitude };
    } catch (e) { /* fall back to the sector centre */ }
    const sector = PLACES.postcodes.find((p) => p[0] === `${m[1].toUpperCase()} ${m[2][0]}`);
    if (sector) return { kind: "postcode", label: pc, sub: `Approximate (centre of ${sector[0]})`, lat: sector[1], lon: sector[2] };
    return null;
  }

  async function searchRemote(query) {
    const out = [];
    const pc = await lookupPostcode(query);
    if (pc) out.push(pc);
    if (String(query).trim().length < 3) return out;
    const url = `${CFG.photonUrl}?q=${encodeURIComponent(query)}&limit=7&lang=en&lat=51.507&lon=-0.128&bbox=-0.56,51.25,0.36,51.72`;
    const data = await fetchJson(url, { timeout: 7000 });
    for (const f of (data && data.features) || []) {
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      const label = p.name || street || p.district || p.city;
      if (!label) continue;
      const sub = [p.name && street, p.district || p.locality, p.postcode].filter(Boolean).join(", ");
      out.push({ kind: "address", label, sub: sub || "Address", lat, lon });
    }
    return out;
  }

  // ---------------------------------------------------------------- TfL journeys

  const TFL_MODES_RAIL = ["tube", "dlr", "overground", "elizabeth-line", "tram", "national-rail", "cable-car"];
  const lineColour = new Map(NET.lines.map(([name, colour]) => [name.toLowerCase(), colour]));
  lineColour.set("london overground", "#EE7C0E");
  const MODE_COLOUR = { bus: "#D9381E", "national-rail": "#5B6770", "river-bus": "#2E8ECF", overground: "#EE7C0E", tram: "#84B817", dlr: "#00A4A7", "elizabeth-line": "#6950A1", "cable-car": "#E21836", coach: "#7A5C3E" };

  const pad = (n) => String(n).padStart(2, "0");

  function parsePath(leg) {
    try {
      const pts = JSON.parse((leg.path && leg.path.lineString) || "[]");
      if (pts.length >= 2) return pts.map(([a, b]) => [a, b]);
    } catch (e) { /* ignore */ }
    const d = leg.departurePoint || {}, a = leg.arrivalPoint || {};
    return d.lat && a.lat ? [[d.lat, d.lon], [a.lat, a.lon]] : [];
  }

  const cleanStop = (s) => String(s || "")
    .replace(/ (Underground|Rail|DLR|Tram|Elizabeth line|Overground) Station$/i, "")
    .replace(/ (Underground|Rail|DLR) Stn$/i, "")
    .replace(/ Station$/i, "")
    .trim();

  function parseJourney(j) {
    const legs = (j.legs || []).map((leg) => {
      const modeId = (leg.mode && leg.mode.id) || "walking";
      const opt = (leg.routeOptions || [])[0] || {};
      const lineName = opt.name || (leg.instruction && leg.instruction.summary) || "";
      const mode = modeId === "walking" ? "walk" : modeId === "cycle" ? "cycle" : modeId;
      const colour = mode === "walk" || mode === "cycle" ? null
        : lineColour.get(String(lineName).toLowerCase()) || lineColour.get(String(lineName).toLowerCase().replace(/ line$/, "")) || MODE_COLOUR[mode] || "#5B6770";
      const stops = ((leg.path && leg.path.stopPoints) || []).length;
      return {
        mode,
        line: mode === "walk" || mode === "cycle" ? null : lineName,
        colour,
        mins: leg.duration || 0,
        summary: (leg.instruction && leg.instruction.summary) || "",
        direction: cleanStop(((opt.directions || [])[0]) || ""),
        from: { name: cleanStop(leg.departurePoint && leg.departurePoint.commonName), lat: leg.departurePoint && leg.departurePoint.lat, lon: leg.departurePoint && leg.departurePoint.lon },
        to: { name: cleanStop(leg.arrivalPoint && leg.arrivalPoint.commonName), lat: leg.arrivalPoint && leg.arrivalPoint.lat, lon: leg.arrivalPoint && leg.arrivalPoint.lon },
        stops,
        depart: leg.departureTime,
        arrive: leg.arrivalTime,
        coords: parsePath(leg),
        disrupted: !!leg.isDisrupted,
      };
    });
    return {
      mins: j.duration,
      start: j.startDateTime,
      end: j.arrivalDateTime,
      fare: j.fare && j.fare.totalCost ? j.fare.totalCost : null,
      legs: legs.filter((l) => l.mins > 0 || l.line),
      estimated: false,
    };
  }

  // Small request queue: TfL limits anonymous use, so at most three requests run at once.
  const queue = [];
  let running = 0;
  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (running < 3 && queue.length) {
      const { task, resolve, reject } = queue.shift();
      running++;
      task().then(resolve, reject).finally(() => { running--; pump(); });
    }
  }

  const journeyCache = new Map();
  let tflDown = false;

  async function tflJourneys(from, to, opts) {
    const o = Object.assign({ rail: true, bus: true, when: null }, opts || {});
    const modes = (o.rail ? TFL_MODES_RAIL : []).concat(o.bus ? ["bus"] : [], ["walking"]);
    let url = `${CFG.tflBase}/Journey/JourneyResults/${from.lat.toFixed(5)},${from.lon.toFixed(5)}/to/${to.lat.toFixed(5)},${to.lon.toFixed(5)}`
      + `?mode=${modes.join(",")}&journeyPreference=leasttime&alternativeWalking=true`;
    if (o.when) {
      const d = o.when;
      url += `&timeIs=Arriving&date=${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}&time=${pad(d.getHours())}${pad(d.getMinutes())}`;
    }
    if (CFG.tflAppKey) url += `&app_key=${encodeURIComponent(CFG.tflAppKey)}`;
    if (journeyCache.has(url)) return journeyCache.get(url);
    const p = enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await fetchJson(url, { timeout: 15000 });
          tflDown = false;
          const list = ((data && data.journeys) || []).map(parseJourney).filter((j) => j.legs.length);
          list.sort((a, b) => a.mins - b.mins);
          // Keep distinct options: different first ride.
          const seen = new Set();
          return list.filter((j) => {
            const key = j.legs.filter((l) => l.line).map((l) => l.line).join(">") || "walk";
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 3);
        } catch (e) {
          if (e.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
          if (e.status === 404 || e.status === 300) return [];
          if (!e.status) tflDown = true;
          throw e;
        }
      }
      return [];
    });
    journeyCache.set(url, p);
    p.catch(() => journeyCache.delete(url));
    return p;
  }

  // ---------------------------------------------------------------- live venues (OpenStreetMap)

  const LIVE_TYPES = {
    cafe: '["amenity"="cafe"]',
    restaurant: '["amenity"="restaurant"]',
    bar: '["amenity"~"^(bar|biergarten)$"]',
    cinema: '["amenity"="cinema"]',
  };
  const liveCache = new Map();
  let liveSeq = 0;

  async function liveVenues(type, box) {
    const filter = LIVE_TYPES[type];
    if (!filter) return [];
    const b = [box.south, box.west, box.north, box.east].map((x) => x.toFixed(3));
    const key = type + b.join(",");
    if (liveCache.has(key)) return liveCache.get(key);
    const query = `[out:json][timeout:20];nwr${filter}["name"](${b.join(",")});out center 700;`;
    const p = (async () => {
      let lastErr;
      for (const base of CFG.overpassUrls || []) {
        try {
          const data = await fetchJson(base, { timeout: 22000, init: { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" } } });
          return (data.elements || []).map((el) => {
            const t = el.tags || {};
            const lat = el.lat ?? (el.center && el.center.lat);
            const lon = el.lon ?? (el.center && el.center.lon);
            if (lat == null || !t.name || /closed|disused/i.test(t.name)) return null;
            let q = 4 + (t.website ? 1 : 0) + (t.outdoor_seating === "yes" ? 1 : 0) + (t.wikidata ? 2 : 0) - (t.brand ? 2 : 0);
            const address = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") + (t["addr:postcode"] ? `, ${t["addr:postcode"]}` : "");
            return {
              id: `o${type[0]}${++liveSeq}`, type, name: t.name, lat, lon, q: Math.max(0, Math.min(9, q)), flags: 0,
              address: address.replace(/^, /, ""), url: /^https?:\/\//.test(t.website || "") ? t.website : "", live: true,
            };
          }).filter(Boolean);
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("No Overpass server");
    })();
    liveCache.set(key, p);
    p.catch(() => liveCache.delete(key));
    return p;
  }

  window.HHServices = {
    searchLocal, searchRemote, lookupPostcode, tflJourneys, liveVenues, LIVE_TYPES,
    get tflDown() { return tflDown; },
    norm,
  };
})();
