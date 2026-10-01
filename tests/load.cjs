// Loads the browser data files and the engine into Node for tests.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DOCS = path.join(__dirname, "..", "docs");

function loadData() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  for (const f of ["network.js", "venues.js", "places.js", "basemap.js"]) {
    vm.runInContext(fs.readFileSync(path.join(DOCS, "data", f), "utf8"), ctx, { filename: f });
  }
  return ctx.window;
}

const HHEngine = require(path.join(DOCS, "engine.js"));
module.exports = { loadData, HHEngine };
