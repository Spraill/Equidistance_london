// Public deployment settings. Safe to commit: nothing here is secret.
window.HH_CONFIG = {
  // TfL Unified API. Works without a key at low volume; register a free app key at
  // https://api-portal.tfl.gov.uk to raise the limit, and paste it here.
  tflAppKey: "",
  tflBase: "https://api.tfl.gov.uk",
  // Map tiles: the standard OpenStreetMap map, as used by Pub_gen. No key needed.
  // Follow https://operations.osmfoundation.org/policies/tiles/ and move to a
  // commercial or self-hosted tile server if traffic grows.
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  photonUrl: "https://photon.komoot.io/api/",
  postcodesUrl: "https://api.postcodes.io/postcodes/",
  overpassUrls: ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"],
};
