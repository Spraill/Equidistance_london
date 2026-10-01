# Halfway House

Find a fair place to meet in London. Add where everyone is starting from, pick
the kind of place (pub, park, museum, gallery, café, restaurant, bar, market,
theatre, cinema; tick as many as you like) and it suggests spots where nobody
gets a raw deal, with each person's route by tube, train, bus and on foot.

The site is static and lives in [`docs/`](docs/), so GitHub Pages can serve it
straight from this repo.

## What it does

- **Up to eight people.** Search a station, postcode, address or place, use your
  current location, tap the pin to choose a spot on the map, or long-press the
  map to add someone there. Markers can be dragged.
- **Two kinds of halfway.**
  - *As the crow flies*: the centre of the smallest circle around everyone, so
    the furthest people are the same straight-line distance away. For two people
    it is the midpoint; for three it is usually the point equidistant from all three.
  - *By transport*: the point where the longest journey is as short as possible.
    The map shades the areas within 3 and 8 minutes of that.
  The summary shows both, including how long the slowest trip to the crow-flies
  point would take, which is often a lot longer. The shading comes from a grid
  of roughly 60 m cells and is redrawn for every screen pixel, so the band edges
  stay sharp at any zoom.
- **Ranked suggestions.** Every venue of the chosen types is scored on everyone's
  journey time. *What counts as fair* sets the trade-off: "Nobody travels far"
  protects whoever is furthest out, "Least travel overall" minimises the total.
  Nicer places (historic pubs, real ale, listed buildings, well-known museums)
  get a small bonus, results are kept a few hundred metres apart, and each chosen
  type is represented.
- **Real routes.** The top suggestions, and any you open, are checked against the
  TfL Journey Planner. Each person gets the fastest route and up to two
  alternatives (for example a bus instead of the tube), drawn on the map in line
  colours, with leave and arrive times, stops, changes and fares, plus links to
  Citymapper and Google Maps. Set *Arrive by* to plan for a time.
- **Share the plan.** *Share plan* gives a link that rebuilds the same group and
  venue; *Copy text* gives a summary for the group chat.
- Works on phones (the panel becomes a bottom sheet you drag up and down) and on
  desktops, in light and dark mode.

## How journey times are worked out

Ranking thousands of venues for several people needs instant answers, so the
app has its own model of London's network (`docs/engine.js`):

1. **Rail network.** Every tube, Elizabeth line, Overground (by its 2024 line
   names), DLR, tram and cable car station, plus the main National Rail routes
   into the termini, with the actual track geometry between stations.
2. **Search.** For each person, Dijkstra's algorithm runs over (station, line)
   pairs, so changing lines costs a walk between platforms plus a typical wait
   for the next train, and nearby separate stations (Bank and Monument, Euston
   and Euston Square) are linked by a walk. Running times come from track length,
   each line's speed and a dwell at every stop.
3. **Getting to and from stations.** Walking (4.8 km/h with a 25% allowance for
   streets not being straight) or a bus to the station when that is quicker.
   Buses are also used for whole journeys, modelled as walk, wait and ride, with
   a change for longer trips.
4. **Every venue and grid point** then takes the quickest combination of those.
   For the fair point, each station's arrival time is spread over a grid of
   roughly 60 m cells (around 250 x 250 for a typical group, in about 0.1 s),
   then the best cell is refined with exact journey times.

The best few suggestions are then checked against TfL for real times, and
reordered if TfL disagrees. Anything marked *Estimate* comes from the model;
*Live* means TfL answered.

## Data

| What | Source | Licence |
| --- | --- | --- |
| Rail lines and stations | OpenStreetMap, as tidied by [Oliver O'Brien](https://github.com/oobrien/vis) (`data/sources/tfl_*.json`) | ODbL |
| Pubs, parks, museums, galleries, markets, theatres | OpenStreetMap snapshot from [Pub_gen](https://github.com/Spraill/Pub_gen) (`data/sources/venues.json`) | ODbL |
| Cafés, restaurants, bars, cinemas | OpenStreetMap, fetched live from Overpass around the fair spot | ODbL |
| Postcode districts and sectors | ONS/OS Code-Point Open via [dwyl](https://github.com/dwyl/uk-postcodes-latitude-longitude-complete-csv) | OGL |
| Borough outlines (fallback map) | ONS boundaries via [martinjc/UK-GeoJSON](https://github.com/martinjc/UK-GeoJSON) | OGL |
| Street and neighbourhood names (fallback map) | OS Open Names via the [uk-address-lookup](https://www.npmjs.com/package/uk-address-lookup) package; central district names placed by hand | OGL |
| Live journeys | [TfL Unified API](https://api.tfl.gov.uk) | TfL Open Data, powered by TfL |
| Address search | [Photon](https://photon.komoot.io) and [postcodes.io](https://postcodes.io) | ODbL / OGL |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org) standard tiles (same as Pub_gen) | ODbL, credited on the map |

The map is OpenStreetMap's standard map. If those tiles can't load it tries a
second OSM tile server (HOT, hosted by OSM France), and if that fails too it
draws its own map: boroughs, the Thames and the rail lines, with place names that
get more detailed as you zoom (boroughs, then districts and stations, then parks
and museums, then every street and pub). If TfL can't be reached, everything
still works from the model.

## Running it

```bash
npm run serve        # http://localhost:8000
npm test             # engine, search and TfL parsing (Node 18+)
npm run test:e2e     # desktop and phone browser test (npm i --no-save playwright)
npm run build        # rebuild docs/data from data/sources (Python 3.10+)
```

To refresh the venues from a newer Pub_gen checkout, or the street names from
a newer OS Open Names release:

```bash
python3 tools/build_data.py --pubgen ../Pub_gen
npm pack uk-address-lookup && tar xzf uk-address-lookup-*.tgz
python3 tools/build_data.py --os-names package/data/uk-address.json.gz
```

### Deploying

GitHub Pages: **Settings → Pages → Build and deployment → Deploy from a branch →
`main` / `/docs`**. The site will be at `https://<user>.github.io/equidistance_london/`.

TfL allows light anonymous use. For more traffic, register a free app key at
[api-portal.tfl.gov.uk](https://api-portal.tfl.gov.uk) and set `tflAppKey` in
`docs/config.js`.

## Privacy

No accounts, cookies or analytics. The group is saved in the browser's local
storage only. Starting points go to TfL (to plan journeys), and what you type in
search goes to Photon or postcodes.io. A share link contains the names and
locations in the group, so only send it to people you'd tell anyway.
