// Public deployment settings. Safe to commit: nothing here is secret.
window.HH_CONFIG = {
  // TfL Unified API. Works without a key at low volume; register a free app key at
  // https://api-portal.tfl.gov.uk to raise the limit, and paste it here.
  tflAppKey: "",
  tflBase: "https://api.tfl.gov.uk",
  // Map tiles (CARTO basemaps, free for low-volume use with attribution).
  tiles: {
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  photonUrl: "https://photon.komoot.io/api/",
  postcodesUrl: "https://api.postcodes.io/postcodes/",
  overpassUrls: ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"],
};
