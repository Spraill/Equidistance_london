const test = require("node:test");
const assert = require("node:assert/strict");
const { loadData, HHEngine } = require("./load.cjs");

const data = loadData();
const E = HHEngine.createEngine(data.HH_NET, data.HH_VENUES.rows);
const station = (name) => {
  const n = E.nodes.find((x) => x.station && x.name === name);
  assert.ok(n, `station ${name} exists`);
  return n;
};
const minsBetween = (a, b) => {
  const A = station(a), B = station(b);
  return E.travel(E.timeField({ lat: A.lat, lon: A.lon }), B.lat, B.lon).mins;
};

test("polyline decoding round-trips a known string", () => {
  // Google's documented example.
  const pts = HHEngine.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
  assert.deepEqual(pts.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test("crow-flies point is the midpoint for two people and equidistant for three", () => {
  const two = HHEngine.minEnclosingCircle([{ lat: 51.5, lon: -0.2 }, { lat: 51.5, lon: 0.0 }]);
  assert.ok(Math.abs(two.lat - 51.5) < 1e-6 && Math.abs(two.lon + 0.1) < 1e-6);
  const pts = [{ lat: 51.46, lon: -0.11 }, { lat: 51.54, lon: -0.14 }, { lat: 51.54, lon: 0.0 }];
  const c = HHEngine.minEnclosingCircle(pts);
  const d = pts.map((p) => HHEngine.haversine(c.lat, c.lon, p.lat, p.lon));
  for (const x of d) assert.ok(Math.abs(x - c.radius) < 60, `distances ${d.map(Math.round)} vs radius ${Math.round(c.radius)}`);
});

test("network covers the main lines as connected pieces", () => {
  const names = E.lines.map((l) => l.name);
  for (const want of ["Victoria", "Northern", "Elizabeth line", "DLR", "Mildmay", "Windrush", "Tram", "National Rail"]) assert.ok(names.includes(want), want);
  assert.ok(E.nodes.filter((n) => n.station && n.lines.length).length > 400);
});

test("journey estimates are in a realistic range", () => {
  const cases = [
    ["Brixton", "Oxford Circus", 14, 24],
    ["Stratford", "Liverpool Street", 9, 18],
    ["Camden Town", "Bank", 15, 25],
    ["Wimbledon", "Waterloo", 18, 32],
    ["Ealing Broadway", "Tottenham Court Road", 15, 28],
  ];
  for (const [a, b, lo, hi] of cases) {
    const m = minsBetween(a, b);
    assert.ok(m >= lo && m <= hi, `${a} -> ${b}: ${m.toFixed(1)} min, expected ${lo}-${hi}`);
  }
});

test("walking is used for short hops", () => {
  const A = station("Leicester Square"), B = station("Covent Garden");
  const t = E.travel(E.timeField({ lat: A.lat, lon: A.lon }), B.lat, B.lon);
  assert.equal(t.kind, "walk");
  assert.ok(t.mins < 6);
});

test("turning off rail and buses leaves walking", () => {
  const A = station("Brixton"), B = station("Oxford Circus");
  const f = E.timeField({ lat: A.lat, lon: A.lon }, { modes: { rail: false, bus: false } });
  const t = E.travel(f, B.lat, B.lon);
  assert.equal(t.kind, "walk");
  assert.ok(t.mins > 60);
});

test("route legs add up and name the lines", () => {
  const A = station("Brixton"), B = station("Camden Town");
  const f = E.timeField({ lat: A.lat, lon: A.lon, name: "Brixton" });
  const r = E.route(f, B.lat, B.lon, "Camden Town");
  const sum = r.legs.reduce((s, l) => s + l.mins, 0);
  assert.ok(Math.abs(sum - r.mins) < 0.5, `legs ${sum} vs total ${r.mins}`);
  assert.ok(r.legs.some((l) => l.line === "Victoria" || l.line === "Northern"));
  for (const l of r.legs) assert.ok(l.coords.length >= 2);
});

test("fair point beats the crow-flies point on the longest journey", () => {
  const people = ["Brixton", "Camden Town", "Stratford", "Hammersmith"].map((n) => { const s = station(n); return { lat: s.lat, lon: s.lon }; });
  const fields = people.map((p) => E.timeField(p));
  const fair = E.fairPoint(fields);
  const crow = HHEngine.minEnclosingCircle(people);
  const crowWorst = Math.max(...fields.map((f) => E.travel(f, crow.lat, crow.lon).mins));
  assert.ok(fair.worst <= crowWorst + 1e-9);
  assert.equal(fair.values.length, fair.nx * fair.ny);
  assert.ok(fair.nx >= 150, `grid ${fair.nx}x${fair.ny}`);
  assert.ok(fair.worst < 40, `worst ${fair.worst}`);
});

test("time grid agrees with exact journey times", () => {
  const A = station("Brixton");
  const f = E.timeField({ lat: A.lat, lon: A.lon });
  const box = { south: 51.45, north: 51.55, west: -0.2, east: -0.05 };
  const nx = 120, ny = 90;
  const T = E.timeRaster(f, box, nx, ny);
  let worstErr = 0;
  for (let k = 0; k < 400; k++) {
    const r = (k * 37) % ny, c = (k * 53) % nx;
    const lat = box.south + (r + 0.5) * (box.north - box.south) / ny;
    const lon = box.west + (c + 0.5) * (box.east - box.west) / nx;
    worstErr = Math.max(worstErr, Math.abs(T[r * nx + c] - E.travel(f, lat, lon).mins));
  }
  assert.ok(worstErr < 0.5, `max difference ${worstErr.toFixed(2)} min`);
});

test("ranking returns spread-out venues of every chosen type", () => {
  const people = ["Brixton", "Camden Town", "Stratford"].map((n) => { const s = station(n); return { lat: s.lat, lon: s.lon }; });
  const fields = people.map((p) => E.timeField(p));
  const { results, considered } = E.rankVenues(fields, ["pub", "park"], { balance: "fair", limit: 8 });
  assert.ok(considered > 500);
  assert.equal(results.length, 8);
  assert.ok(results.some((r) => r.venue.type === "pub") && results.some((r) => r.venue.type === "park"));
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      assert.ok(HHEngine.haversine(results[i].venue.lat, results[i].venue.lon, results[j].venue.lat, results[j].venue.lon) > 280);
    }
  }
  for (const r of results) assert.equal(r.times.length, 3);
});

test("fair weighting avoids one person doing all the travelling", () => {
  const people = ["Brixton", "Camden Town", "Stratford", "Hammersmith"].map((n) => { const s = station(n); return { lat: s.lat, lon: s.lon }; });
  const fields = people.map((p) => E.timeField(p));
  const fair = E.rankVenues(fields, ["pub"], { balance: "fair" }).results[0];
  assert.ok(fair.spread < 12, `spread ${fair.spread}`);
});
