// Browser test, desktop and phone. TfL, tiles and search services are mocked so it runs offline.
//   npm i --no-save playwright && node tests/e2e.cjs     (SCREENSHOTS=dir to save screenshots)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "docs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SHOTS = process.env.SCREENSHOTS;

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/\/$/, "/index.html"));
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    }).listen(0, () => resolve(server));
  });
}

// A believable TfL answer between any two points: walk, tube, walk; plus a bus alternative.
function fakeJourneys(url) {
  const m = url.match(/JourneyResults\/([-\d.]+),([-\d.]+)\/to\/([-\d.]+),([-\d.]+)/);
  const [a, b, c, d] = m.slice(1).map(Number);
  const mid1 = [a + (c - a) * 0.1, b + (d - b) * 0.1], mid2 = [a + (c - a) * 0.9, b + (d - b) * 0.9];
  const leg = (mode, line, mins, p, q, dir) => ({
    duration: mins, mode: { id: mode }, instruction: { summary: `${line || "Walk"}` },
    routeOptions: [{ name: line || "", directions: [dir || ""] }],
    departurePoint: { commonName: "Start Underground Station", lat: p[0], lon: p[1] },
    arrivalPoint: { commonName: "End Underground Station", lat: q[0], lon: q[1] },
    path: { lineString: JSON.stringify([p, q]), stopPoints: mode === "walking" ? [] : [{}, {}, {}, {}] },
  });
  return {
    journeys: [
      { duration: 24, startDateTime: "2026-10-01T18:36:00", arrivalDateTime: "2026-10-01T19:00:00", fare: { totalCost: 290 },
        legs: [leg("walking", "", 4, [a, b], mid1), leg("tube", "Central", 15, mid1, mid2, "Epping Underground Station"), leg("walking", "", 5, mid2, [c, d])] },
      { duration: 33, startDateTime: "2026-10-01T18:27:00", arrivalDateTime: "2026-10-01T19:00:00",
        legs: [leg("walking", "", 3, [a, b], mid1), leg("bus", "38", 26, mid1, mid2, "Victoria"), leg("walking", "", 4, mid2, [c, d])] },
    ],
  };
}

async function run(browser, base, name, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.tfl.gov.uk/**", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(fakeJourneys(r.request().url())) }));
  await page.route("https://*.basemaps.cartocdn.com/**", (r) => r.abort());
  await page.route("https://photon.komoot.io/**", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ features: [{ geometry: { coordinates: [-0.0877, 51.5055] }, properties: { name: "Borough Market", street: "Southwark Street", postcode: "SE1 1TL", district: "Southwark" } }] }) }));
  await page.route("https://api.postcodes.io/**", (r) => r.abort());
  await page.route("https://overpass-api.de/**", (r) => r.abort());
  await page.route("https://overpass.private.coffee/**", (r) => r.abort());

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".venue");
  const count = await page.locator(".venue").count();
  if (count < 5) throw new Error(`${name}: expected suggestions, got ${count}`);
  await page.waitForSelector(".venue .badge-live", { timeout: 10000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-results.png`) });

  await page.locator(".venue").first().click();
  await page.waitForSelector(".journey");
  const journeys = await page.locator(".journey").count();
  if (journeys !== 3) throw new Error(`${name}: expected 3 journeys, got ${journeys}`);
  await page.waitForSelector(".options-tabs button");
  await page.locator(".options-tabs button").nth(1).click();
  await page.waitForTimeout(300);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-journeys.png`) });

  await page.click("#backBtn");
  await page.click("#editGroup");
  const input = page.locator(".where-input").first();
  await input.click();
  await input.fill("borough mar");
  await page.waitForSelector(".suggest li[data-i]");
  await page.waitForTimeout(600);
  await page.locator(".suggest li[data-i]", { hasText: "Borough Market" }).first().dispatchEvent("mousedown");
  await page.waitForTimeout(300);
  const label = await input.inputValue();
  if (!/Borough Market/.test(label)) throw new Error(`${name}: search selection failed (${label})`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-edit.png`) });

  if (errors.length) throw new Error(`${name}: page errors: ${errors.join("; ")}`);
  console.log(`ok ${name}`);
  await ctx.close();
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    await run(browser, base, "desktop", { viewport: { width: 1366, height: 900 } });
    await run(browser, base, "phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
