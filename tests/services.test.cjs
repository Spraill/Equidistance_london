// Place search and TfL response parsing, with the network mocked out.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DOCS = path.join(__dirname, "..", "docs");

function loadServices(fetchImpl) {
  const ctx = { window: {}, console, setTimeout, clearTimeout, AbortController, URLSearchParams, Promise };
  ctx.fetch = fetchImpl;
  vm.createContext(ctx);
  for (const f of ["data/network.js", "data/venues.js", "data/places.js", "config.js", "services.js"]) {
    vm.runInContext(fs.readFileSync(path.join(DOCS, f), "utf8").replace(/\bwindow\.fetch\b/g, "fetch"), ctx, { filename: f });
  }
  ctx.window.fetch = fetchImpl;
  return ctx.window.HHServices;
}

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });

const SAMPLE = {
  journeys: [{
    startDateTime: "2026-10-01T18:32:00", arrivalDateTime: "2026-10-01T18:58:00", duration: 26,
    fare: { totalCost: 290 },
    legs: [
      { duration: 4, mode: { id: "walking" }, instruction: { summary: "Walk to Brixton Underground Station" },
        routeOptions: [{ name: "", directions: [""] }],
        departurePoint: { commonName: "51.4627,-0.1145", lat: 51.4627, lon: -0.1145 },
        arrivalPoint: { commonName: "Brixton Underground Station", lat: 51.4626, lon: -0.1146 },
        path: { lineString: "[[51.4627,-0.1145],[51.4626,-0.1146]]", stopPoints: [] } },
      { duration: 15, mode: { id: "tube" }, instruction: { summary: "Victoria line to Oxford Circus" },
        routeOptions: [{ name: "Victoria", directions: ["Walthamstow Central Underground Station"] }],
        departurePoint: { commonName: "Brixton Underground Station", lat: 51.4626, lon: -0.1146 },
        arrivalPoint: { commonName: "Oxford Circus Underground Station", lat: 51.5152, lon: -0.1418 },
        path: { lineString: "[[51.4626,-0.1146],[51.4722,-0.1227],[51.5152,-0.1418]]", stopPoints: [{}, {}, {}, {}, {}, {}] } },
      { duration: 7, mode: { id: "walking" }, instruction: { summary: "Walk to destination" },
        routeOptions: [{ name: "" }],
        departurePoint: { commonName: "Oxford Circus Underground Station", lat: 51.5152, lon: -0.1418 },
        arrivalPoint: { commonName: "51.5145,-0.1490", lat: 51.5145, lon: -0.149 },
        path: { lineString: "[[51.5152,-0.1418],[51.5145,-0.1490]]" } },
    ],
  }, {
    startDateTime: "2026-10-01T18:20:00", arrivalDateTime: "2026-10-01T18:59:00", duration: 39,
    legs: [{ duration: 39, mode: { id: "bus" }, instruction: { summary: "159 bus to Oxford Street" },
      routeOptions: [{ name: "159", directions: ["Marble Arch"] }],
      departurePoint: { commonName: "Brixton Station", lat: 51.4627, lon: -0.1145 }, arrivalPoint: { commonName: "Oxford Circus", lat: 51.515, lon: -0.142 },
      path: { lineString: "[[51.4627,-0.1145],[51.515,-0.142]]", stopPoints: [{}, {}] } }],
  }],
};

test("local search finds stations, postcodes and venues", () => {
  const S = loadServices(() => Promise.reject(new Error("offline")));
  const water = S.searchLocal("waterloo", 5);
  assert.equal(water[0].label, "Waterloo");
  assert.equal(water[0].kind, "station");
  const pc = S.searchLocal("SW9", 5);
  assert.ok(pc.some((r) => r.kind === "postcode" && r.label === "SW9"));
  const museum = S.searchLocal("british museum", 5);
  assert.ok(museum.some((r) => r.label === "British Museum"));
  const coords = S.searchLocal("51.5074, -0.1278", 5);
  assert.equal(coords[0].kind, "coords");
});

test("full postcodes fall back to the sector centre when offline", async () => {
  const S = loadServices(() => Promise.reject(new Error("offline")));
  const r = await S.lookupPostcode("sw9 8he");
  assert.equal(r.label, "SW9 8HE");
  assert.match(r.sub, /Approximate/);
  assert.ok(r.lat > 51.4 && r.lat < 51.5);
});

test("TfL journeys are parsed into legs with line colours and paths", async () => {
  let called = "";
  const S = loadServices((url) => { called = url; return json(SAMPLE); });
  const when = new Date(2026, 9, 1, 19, 0);
  const js = await S.tflJourneys({ lat: 51.4627, lon: -0.1145 }, { lat: 51.5145, lon: -0.149 }, { rail: true, bus: true, when });
  assert.match(called, /\/Journey\/JourneyResults\/51\.46270,-0\.11450\/to\/51\.51450,-0\.14900\?/);
  assert.match(called, /timeIs=Arriving&date=20261001&time=1900/);
  assert.match(called, /mode=tube,dlr,overground,elizabeth-line,tram,national-rail,cable-car,bus,walking/);
  assert.equal(js.length, 2);
  const [fast, bus] = js;
  assert.equal(fast.mins, 26);
  assert.equal(fast.legs.length, 3);
  assert.equal(fast.legs[1].line, "Victoria");
  assert.equal(fast.legs[1].colour, "#0098D4");
  assert.equal(fast.legs[1].direction, "Walthamstow Central");
  assert.equal(fast.legs[1].from.name, "Brixton");
  assert.equal(fast.legs[1].stops, 6);
  assert.equal(fast.legs[1].coords.length, 3);
  assert.equal(fast.legs[0].mode, "walk");
  assert.equal(fast.legs[0].line, null);
  assert.equal(fast.fare, 290);
  assert.equal(bus.legs[0].mode, "bus");
  assert.equal(bus.legs[0].line, "159");
});

test("no buses means no bus mode in the TfL request", async () => {
  let called = "";
  const S = loadServices((url) => { called = url; return json({ journeys: [] }); });
  await S.tflJourneys({ lat: 51.5, lon: -0.1 }, { lat: 51.52, lon: -0.12 }, { rail: true, bus: false });
  assert.ok(!/bus,/.test(called.split("mode=")[1].split("&")[0]));
  assert.ok(!/timeIs=/.test(called));
});
