/*
 * Halfway House routing engine. Pure functions, no DOM: shared by the app and the Node tests.
 *
 * The engine estimates door-to-door journey times across London by combining:
 *   - walking (street detour factor applied to straight-line distance),
 *   - buses (modelled as a slower, direct-ish mode with a walk to the stop and a wait),
 *   - the rail network (tube, Elizabeth line, Overground, DLR, tram, main National Rail routes),
 *     searched with Dijkstra over (station, line) states so changes cost a walk and a wait,
 *   - buses or walks to and from stations at either end.
 * Those estimates rank every candidate venue instantly; the app then checks the best few
 * against the TfL Journey Planner for live times and exact routes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HHEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------- tunables (minutes, metres)
  const WALK_M_PER_MIN = 80;        // 4.8 km/h
  const WALK_DETOUR = 1.25;         // streets are not straight lines
  const BUS_M_PER_MIN = 190;        // ~11.4 km/h door-to-door average in traffic, stops included
  const BUS_DETOUR = 1.35;
  const BUS_FIXED = 9;              // walk to the stop, wait, walk from the stop
  const BUS_CHANGE_OVER = 6000;     // longer bus trips usually need a change
  const BUS_CHANGE_PENALTY = 7;
  const BUS_MAX = 11000;
  const STATION_WALK_MAX = 2000;    // walk to or from a station
  const STATION_BUS_MAX = 5000;     // bus to or from a station
  const ENTRY_MINS = 2;             // street to platform
  const EXIT_MINS = 1.5;            // platform to street
  const CHANGE_MINS = 3.5;          // walk between platforms when changing line
  const LONDON = { south: 51.25, north: 51.72, west: -0.56, east: 0.36 };

  // ---------------------------------------------------------------- geometry

  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    const dp = rad(lat2 - lat1);
    const dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function decodePolyline(str, precision) {
    const factor = Math.pow(10, precision || 5);
    const out = [];
    let index = 0, lat = 0, lon = 0;
    while (index < str.length) {
      for (let k = 0; k < 2; k++) {
        let shift = 0, result = 0, byte;
        do {
          byte = str.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        const delta = result & 1 ? ~(result >> 1) : result >> 1;
        if (k === 0) lat += delta; else lon += delta;
      }
      out.push([lat / factor, lon / factor]);
    }
    return out;
  }

  // Local flat projection around a reference latitude (metres). Accurate to well under 1% across London.
  function projector(lat0) {
    const kx = 111320 * Math.cos(rad(lat0));
    const ky = 110540;
    return {
      to: (lat, lon) => [lon * kx, lat * ky],
      from: (x, y) => [y / ky, x / kx],
    };
  }

  /** Smallest circle containing every point (Welzl). Its centre is the "as the crow flies" halfway point. */
  function minEnclosingCircle(points) {
    if (!points.length) return null;
    const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const pj = projector(lat0);
    const P = points.map((p) => pj.to(p.lat, p.lon));
    const circle2 = (a, b) => {
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return { c, r: Math.hypot(a[0] - c[0], a[1] - c[1]) };
    };
    const circle3 = (a, b, c) => {
      const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      if (Math.abs(d) < 1e-9) {
        const pairs = [circle2(a, b), circle2(a, c), circle2(b, c)];
        return pairs.reduce((m, x) => (x.r > m.r ? x : m));
      }
      const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
      const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
      const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
      return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
    };
    const inside = (circ, p) => Math.hypot(p[0] - circ.c[0], p[1] - circ.c[1]) <= circ.r + 1e-6;
    let c = { c: P[0], r: 0 };
    for (let i = 1; i < P.length; i++) {
      if (inside(c, P[i])) continue;
      c = { c: P[i], r: 0 };
      for (let j = 0; j < i; j++) {
        if (inside(c, P[j])) continue;
        c = circle2(P[i], P[j]);
        for (let k = 0; k < j; k++) {
          if (!inside(c, P[k])) c = circle3(P[i], P[j], P[k]);
        }
      }
    }
    const [lat, lon] = pj.from(c.c[0], c.c[1]);
    return { lat, lon, radius: c.r };
  }

  // ---------------------------------------------------------------- simple modes

  const walkMins = (m) => (m * WALK_DETOUR) / WALK_M_PER_MIN;
  const busMins = (m) => BUS_FIXED + (m * BUS_DETOUR) / BUS_M_PER_MIN + (m > BUS_CHANGE_OVER ? BUS_CHANGE_PENALTY : 0);

  /** Quickest way to cover a short street-level hop: walk, or bus when it is clearly faster. */
  function streetHop(m, maxBus) {
    const w = walkMins(m);
    if (m > 700 && m <= maxBus) {
      const b = busMins(m);
      if (b < w) return { mins: b, mode: "bus" };
    }
    return { mins: w, mode: "walk" };
  }

  // ---------------------------------------------------------------- min-heap

  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v;
      const topK = k[0], topV = v[0];
      const lastK = k.pop(), lastV = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lastK) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lastK; v[i] = lastV;
      }
      return [topK, topV];
    }
  }

  // ---------------------------------------------------------------- network

  function createEngine(net, venueRows) {
    const lines = net.lines.map(([name, colour, mode, vmax, dwell, wait]) => ({ name, colour, mode, vmax, dwell, wait }));
    const L = lines.length;
    const S = net.stationCount;
    const nodes = net.nodes.map(([name, lat, lon, zone, ls], i) => ({ i, name, lat, lon, zone, lines: ls, station: i < S }));
    const N = nodes.length;
    const geomCache = new Map();
    const geom = (g) => {
      if (!geomCache.has(g)) geomCache.set(g, decodePolyline(net.geoms[g], 5));
      return geomCache.get(g);
    };

    // Ride adjacency per (node, line) state.
    const ride = Array.from({ length: N * L }, () => []);
    net.edges.forEach(([a, b, l, metres, g], e) => {
      const ln = lines[l];
      const mins = ln.dwell + metres / ((ln.vmax * 1000) / 60);
      ride[a * L + l].push({ to: b, mins, e, forward: true });
      ride[b * L + l].push({ to: a, mins, e, forward: false });
    });
    const walkLinks = Array.from({ length: N }, () => []);
    for (const [a, b, metres] of net.transfers) {
      walkLinks[a].push({ to: b, metres });
      walkLinks[b].push({ to: a, metres });
    }

    // Spatial grid of stations for "which stations are near this point".
    const CELL = 0.02; // degrees, ~2.2 km north-south
    const grid = new Map();
    const cellKey = (lat, lon) => Math.floor(lat / CELL) * 100000 + Math.floor(lon / CELL);
    for (let i = 0; i < S; i++) {
      if (!nodes[i].lines.length) continue;
      const key = cellKey(nodes[i].lat, nodes[i].lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    function stationsNear(lat, lon, metres) {
      const out = [];
      const dLat = metres / 110540 / CELL;
      const dLon = metres / (111320 * Math.cos(rad(lat))) / CELL;
      const r0 = Math.floor(lat / CELL - dLat), r1 = Math.floor(lat / CELL + dLat);
      const c0 = Math.floor(lon / CELL - dLon), c1 = Math.floor(lon / CELL + dLon);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const list = grid.get(r * 100000 + c);
          if (!list) continue;
          for (const i of list) {
            const d = haversine(lat, lon, nodes[i].lat, nodes[i].lon);
            if (d <= metres) out.push([i, d]);
          }
        }
      }
      return out;
    }

    const venues = (venueRows || []).map(([type, name, lat, lon, q, flags, address, url], i) => ({
      id: i, type, name, lat, lon, q, flags, address, url,
    }));

    // ---------------------------------------------------------------- per-person time field

    /**
     * Earliest arrival (minutes from leaving the door) at every station, with back-pointers.
     * opts.modes: { rail: bool, bus: bool } — walking is always allowed.
     */
    function timeField(origin, opts) {
      const modes = Object.assign({ rail: true, bus: true }, (opts && opts.modes) || {});
      const dist = new Float64Array(N * L).fill(Infinity);
      const pred = new Int32Array(N * L).fill(-1);      // previous state
      const how = new Array(N * L);                      // how we got here
      const heap = new Heap();
      const busMax = modes.bus ? STATION_BUS_MAX : 0;

      if (modes.rail) {
        for (const [s, d] of stationsNear(origin.lat, origin.lon, Math.max(STATION_WALK_MAX, busMax))) {
          const hop = streetHop(d, busMax);
          if (hop.mode === "walk" && d > STATION_WALK_MAX) continue;
          const access = hop.mins + ENTRY_MINS;
          for (const l of nodes[s].lines) {
            const t = access + lines[l].wait;
            const st = s * L + l;
            if (t < dist[st]) {
              dist[st] = t;
              how[st] = { kind: "access", mode: hop.mode, mins: hop.mins, metres: d, wait: lines[l].wait };
              heap.push(t, st);
            }
          }
        }
      }

      while (heap.size) {
        const [t, st] = heap.pop();
        if (t > dist[st]) continue;
        const n = (st / L) | 0, l = st % L;
        for (const r of ride[st]) {
          const ns = r.to * L + l, nt = t + r.mins;
          if (nt < dist[ns]) { dist[ns] = nt; pred[ns] = st; how[ns] = { kind: "ride", e: r.e, forward: r.forward, mins: r.mins }; heap.push(nt, ns); }
        }
        if (!nodes[n].station) continue;
        for (const l2 of nodes[n].lines) {
          if (l2 === l) continue;
          const ns = n * L + l2, nt = t + CHANGE_MINS + lines[l2].wait;
          if (nt < dist[ns]) { dist[ns] = nt; pred[ns] = st; how[ns] = { kind: "change", mins: CHANGE_MINS, wait: lines[l2].wait }; heap.push(nt, ns); }
        }
        for (const w of walkLinks[n]) {
          const walk = walkMins(w.metres) + 2;
          for (const l2 of nodes[w.to].lines) {
            const ns = w.to * L + l2, nt = t + walk + lines[l2].wait;
            if (nt < dist[ns]) { dist[ns] = nt; pred[ns] = st; how[ns] = { kind: "transfer", mins: walk, wait: lines[l2].wait, metres: w.metres }; heap.push(nt, ns); }
          }
        }
      }

      // Best arrival at each station's street exit.
      const arrive = new Float64Array(S).fill(Infinity);
      const arriveState = new Int32Array(S).fill(-1);
      for (let s = 0; s < S; s++) {
        for (const l of nodes[s].lines) {
          const st = s * L + l;
          // Riding through a station you boarded at and straight back out is never useful.
          if (how[st] && how[st].kind === "access") continue;
          const t = dist[st] + EXIT_MINS;
          if (t < arrive[s]) { arrive[s] = t; arriveState[s] = st; }
        }
      }
      return { origin, modes, dist, pred, how, arrive, arriveState };
    }

    /** Best estimated journey from a time field to a point: { mins, kind, station, egress } */
    function travel(field, lat, lon) {
      const o = field.origin;
      const d0 = haversine(o.lat, o.lon, lat, lon);
      let best = { mins: walkMins(d0), kind: "walk", metres: d0 };
      if (field.modes.bus && d0 > 700 && d0 <= BUS_MAX) {
        const b = busMins(d0);
        if (b < best.mins) best = { mins: b, kind: "bus", metres: d0 };
      }
      if (!field.modes.rail) return best;
      const busMax = field.modes.bus ? STATION_BUS_MAX : 0;
      for (const [s, d] of stationsNear(lat, lon, Math.max(STATION_WALK_MAX, busMax))) {
        const a = field.arrive[s];
        if (a === Infinity || a >= best.mins) continue;
        const hop = streetHop(d, busMax);
        if (hop.mode === "walk" && d > STATION_WALK_MAX) continue;
        const t = a + hop.mins;
        if (t < best.mins) best = { mins: t, kind: "rail", station: s, egress: hop, metres: d };
      }
      return best;
    }

    /** Turn an estimate into legs the UI can show and draw. */
    function route(field, lat, lon, label) {
      const t = travel(field, lat, lon);
      const o = field.origin;
      const dest = { lat, lon, name: label || "the meeting point" };
      const streetLeg = (mode, mins, from, to) => ({
        mode, mins, from, to,
        coords: [[from.lat, from.lon], [to.lat, to.lon]],
        estimated: true,
      });
      if (t.kind !== "rail") {
        return { mins: t.mins, estimated: true, legs: [streetLeg(t.kind, t.mins, { lat: o.lat, lon: o.lon, name: o.name || "Start" }, dest)] };
      }
      // Walk the back-pointers from the arrival station to the access leg.
      const chain = [];
      let st = field.arriveState[t.station];
      while (st >= 0) { chain.push(st); st = field.pred[st]; }
      chain.reverse();
      const legs = [];
      const nodeOf = (s) => nodes[(s / L) | 0];
      const first = chain[0];
      const access = field.how[first];
      const firstStation = nodeOf(first);
      legs.push(streetLeg(access.mode, access.mins + ENTRY_MINS, { lat: o.lat, lon: o.lon, name: o.name || "Start" }, firstStation));
      let ride = null;
      const flush = () => { if (ride) { legs.push(ride); ride = null; } };
      let waitNext = access.wait;
      for (let i = 1; i < chain.length; i++) {
        const s = chain[i];
        const h = field.how[s];
        const n = nodeOf(s);
        const line = lines[s % L];
        if (h.kind === "ride") {
          const e = net.edges[h.e];
          let pts = geom(e[4]);
          if (!h.forward) pts = pts.slice().reverse();
          if (!ride) {
            ride = { mode: line.mode, line: line.name, colour: line.colour, from: nodeOf(chain[i - 1]), to: n, stops: 0, mins: waitNext, wait: waitNext, coords: [], estimated: true };
          }
          ride.to = n;
          if (n.station) ride.stops += 1;
          ride.mins += h.mins;
          ride.coords = ride.coords.length ? ride.coords.concat(pts.slice(1)) : pts.slice();
        } else if (h.kind === "change") {
          flush();
          waitNext = h.wait;
          legs.push({ mode: "change", mins: h.mins, at: n, estimated: true });
        } else if (h.kind === "transfer") {
          flush();
          waitNext = h.wait;
          legs.push(Object.assign(streetLeg("walk", h.mins, nodeOf(chain[i - 1]), n), { transfer: true }));
        }
      }
      flush();
      const lastStation = nodes[t.station];
      legs.push(streetLeg(t.egress.mode, t.egress.mins + EXIT_MINS, lastStation, dest));
      // Fold platform changes into the ride that follows (shown as "change at X").
      const merged = [];
      for (const leg of legs) {
        if (leg.mode === "change") { merged.changeAt = leg; continue; }
        if (merged.changeAt && leg.line) { leg.mins += merged.changeAt.mins; leg.changeAt = merged.changeAt.at; merged.changeAt = null; }
        merged.push(leg);
      }
      return { mins: t.mins, estimated: true, legs: merged.filter((l) => l.mins > 0.2 || l.line) };
    }

    // ---------------------------------------------------------------- fairness

    // How to weigh a group's journey times. max = the longest journey, mean = the average,
    // sd = how uneven they are. "fair" protects whoever lives furthest out; "quick" minimises
    // total travel even if one person has a longer trip.
    const BALANCE = {
      fair: { max: 0.9, sd: 0.8 },
      balanced: { max: 0.6, sd: 0.5 },
      quick: { max: 0.2, sd: 0.15 },
    };

    function score(times, balance) {
      const w = BALANCE[balance] || BALANCE.balanced;
      let max = 0, sum = 0;
      for (const t of times) { if (t > max) max = t; sum += t; }
      const mean = sum / times.length;
      let v = 0;
      for (const t of times) v += (t - mean) ** 2;
      const sd = Math.sqrt(v / times.length);
      return w.max * max + (1 - w.max) * mean + w.sd * sd;
    }

    /** Area to search: everyone's starting points plus a margin, inside Greater London. */
    function searchBox(people) {
      let s = 90, n = -90, w = 180, e = -180;
      for (const p of people) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
      const padLat = Math.max(0.018, (n - s) * 0.25);
      const padLon = Math.max(0.03, (e - w) * 0.25);
      return {
        south: Math.max(LONDON.south, s - padLat), north: Math.min(LONDON.north, n + padLat),
        west: Math.max(LONDON.west, w - padLon), east: Math.min(LONDON.east, e + padLon),
      };
    }

    /**
     * The point where the slowest journey is as short as possible: the fairest spot by transport.
     * Also returns the grid of worst-journey times for a heat map.
     */
    function fairPoint(fields, opts) {
      const people = fields.map((f) => f.origin);
      const box = (opts && opts.box) || searchBox(people);
      const cells = (opts && opts.cells) || 64;
      const latStep = (box.north - box.south) / cells;
      const lonStep = (box.east - box.west) / cells;
      const values = new Float32Array(cells * cells);
      let best = null;
      for (let r = 0; r < cells; r++) {
        const lat = box.south + (r + 0.5) * latStep;
        for (let c = 0; c < cells; c++) {
          const lon = box.west + (c + 0.5) * lonStep;
          const times = fields.map((f) => travel(f, lat, lon).mins);
          const worst = Math.max(...times);
          values[r * cells + c] = worst;
          const total = times.reduce((a, b) => a + b, 0);
          if (!best || worst < best.worst - 1e-9 || (Math.abs(worst - best.worst) < 0.5 && total < best.total)) {
            best = { lat, lon, times, worst, total };
          }
        }
      }
      // Refine around the winner on a finer grid.
      const fine = 9;
      const base = best;
      for (let r = -fine; r <= fine; r++) {
        for (let c = -fine; c <= fine; c++) {
          const lat = base.lat + (r / fine) * latStep, lon = base.lon + (c / fine) * lonStep;
          const times = fields.map((f) => travel(f, lat, lon).mins);
          const worst = Math.max(...times);
          const total = times.reduce((a, b) => a + b, 0);
          if (worst < best.worst - 1e-9 || (Math.abs(worst - best.worst) < 0.25 && total < best.total)) best = { lat, lon, times, worst, total };
        }
      }
      return { lat: best.lat, lon: best.lon, times: best.times, worst: best.worst, box, cells, values };
    }

    /**
     * Rank venues of the chosen types for this group.
     * Returns the best few, spread out so they are not all on one street, with every chosen type represented.
     */
    function rankVenues(fields, types, opts) {
      const o = Object.assign({ balance: "balanced", limit: 8, minGap: 280, box: null, extra: [] }, opts || {});
      const box = o.box || searchBox(fields.map((f) => f.origin));
      const want = new Set(types);
      const scored = [];
      for (const v of o.extra.length ? venues.concat(o.extra) : venues) {
        if (!want.has(v.type)) continue;
        if (v.lat < box.south || v.lat > box.north || v.lon < box.west || v.lon > box.east) continue;
        const times = fields.map((f) => travel(f, v.lat, v.lon).mins);
        const s = score(times, o.balance) - (v.q / 9) * 3;
        scored.push({ venue: v, times, score: s, worst: Math.max(...times), spread: Math.max(...times) - Math.min(...times) });
      }
      scored.sort((a, b) => a.score - b.score);
      const picked = [];
      const far = (c) => picked.every((p) => haversine(p.venue.lat, p.venue.lon, c.venue.lat, c.venue.lon) > o.minGap);
      // The best of each type first, then the rest by score.
      for (const type of types) {
        const top = scored.find((c) => c.venue.type === type && far(c));
        if (top) picked.push(top);
      }
      for (const c of scored) {
        if (picked.length >= o.limit) break;
        if (!picked.includes(c) && far(c)) picked.push(c);
      }
      picked.sort((a, b) => a.score - b.score);
      return { results: picked.slice(0, o.limit), considered: scored.length, box };
    }

    function nearestStation(lat, lon) {
      let best = null;
      for (const [s, d] of stationsNear(lat, lon, 3000)) if (!best || d < best.d) best = { station: nodes[s], d };
      return best;
    }

    return {
      lines, nodes, venues, net,
      geom, timeField, travel, route, fairPoint, rankVenues, score, searchBox, stationsNear, nearestStation,
    };
  }

  return {
    createEngine, haversine, decodePolyline, minEnclosingCircle, walkMins, busMins, LONDON,
  };
});
