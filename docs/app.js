/* Halfway House: UI, map and state. */
(function () {
  "use strict";

  const CFG = window.HH_CONFIG || {};
  const S = window.HHServices;
  const HH = window.HHEngine;
  const E = HH.createEngine(window.HH_NET, window.HH_VENUES.rows);

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
  const fmtMins = (m) => `${Math.max(1, Math.round(m))}`;
  const fmtClock = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const mq = window.matchMedia("(max-width: 860px)");

  const COLOURS = ["#E4572E", "#2E86DE", "#D29200", "#9B59B6", "#17A589", "#D6336C", "#6B8E23", "#5D6D7E"];
  const LETTERS = "ABCDEFGH";
  const MAX_PEOPLE = 8;

  const TYPES = [
    { id: "pub", label: "Pub", icon: "i-pub" },
    { id: "park", label: "Park", icon: "i-park" },
    { id: "museum", label: "Museum", icon: "i-museum" },
    { id: "gallery", label: "Gallery", icon: "i-gallery" },
    { id: "cafe", label: "Café", icon: "i-cafe", live: true },
    { id: "restaurant", label: "Restaurant", icon: "i-restaurant", live: true },
    { id: "bar", label: "Bar", icon: "i-bar", live: true },
    { id: "market", label: "Market", icon: "i-market" },
    { id: "theatre", label: "Theatre", icon: "i-theatre" },
    { id: "cinema", label: "Cinema", icon: "i-cinema", live: true },
  ];
  const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const PLURAL = { pub: "pubs", park: "parks", museum: "museums", gallery: "galleries", cafe: "cafés", restaurant: "restaurants", bar: "bars", market: "markets", theatre: "theatres", cinema: "cinemas" };
  const PUB_FLAGS = [[1, "Food"], [2, "Real ale"], [4, "Outdoor seating"], [8, "Step-free"], [16, "Dog friendly"], [32, "Historic"], [128, "Live music"]];

  // ---------------------------------------------------------------- state

  let uid = 0;
  const state = {
    people: [],
    types: new Set(["pub"]),
    balance: "balanced",
    modes: { rail: true, bus: true },
    when: null,
    example: false,
    fields: null,
    fair: null,
    crow: null,
    crowWorst: null,
    ranking: null,
    selected: null,
    picking: null,
    live: new Map(),
    chosen: new Map(),
    liveTypes: new Map(),
    liveCheckTimer: 0,
    editing: true,
  };

  const person = (o) => ({ id: ++uid, name: o.name || "", place: o.place || null, colour: null });
  const located = () => state.people.filter((p) => p.place);
  function recolour() {
    state.people.forEach((p, i) => { p.colour = COLOURS[i % COLOURS.length]; p.letter = LETTERS[i]; });
  }
  const displayName = (p) => p.name.trim() || `Person ${p.letter}`;
  const initial = (p) => (p.name.trim() ? p.name.trim()[0].toUpperCase() : p.letter);

  function stationPlace(name, sub) {
    const n = E.nodes.find((x) => x.name === name && x.station);
    return n ? { label: name, sub: sub || `Station · Zone ${n.zone || "?"}`, lat: n.lat, lon: n.lon, kind: "station" } : null;
  }

  function exampleGroup() {
    return [
      person({ name: "Ama", place: stationPlace("Brixton") }),
      person({ name: "Tom", place: stationPlace("Camden Town") }),
      person({ name: "Priya", place: stationPlace("Stratford") }),
    ];
  }

  // ---------------------------------------------------------------- persistence and sharing

  const STORE = "halfway-house:v1";
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        people: state.people.map((p) => ({ name: p.name, place: p.place })),
        types: [...state.types], balance: state.balance, modes: state.modes, example: state.example,
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  const enc = (s) => encodeURIComponent(s).replace(/~/g, "%7E");
  function shareUrl() {
    const people = located().map((p) => [enc(p.name.trim()), p.place.lat.toFixed(5), p.place.lon.toFixed(5), enc(p.place.label)].join("~")).join("|");
    const parts = [`p=${people}`, `t=${[...state.types].join(",")}`, `f=${state.balance}`, `m=${state.modes.rail ? "r" : ""}${state.modes.bus ? "b" : ""}`];
    if (state.selected) parts.push(`v=${enc(state.selected.venue.name)}`);
    return `${location.origin}${location.pathname}#${parts.join("&")}`;
  }
  function readHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h.includes("p=")) return null;
    const params = Object.fromEntries(h.split("&").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    const people = (params.p || "").split("|").filter(Boolean).map((chunk) => {
      const [name, lat, lon, label] = chunk.split("~");
      const la = parseFloat(lat), lo = parseFloat(lon);
      if (!(la > 51 && la < 52 && lo > -1 && lo < 1)) return null;
      return { name: decodeURIComponent(name || "").slice(0, 40), place: { label: decodeURIComponent(label || "Shared spot").slice(0, 80), sub: "From a shared link", lat: la, lon: lo } };
    }).filter(Boolean).slice(0, MAX_PEOPLE);
    if (!people.length) return null;
    const types = (params.t || "pub").split(",").filter((t) => TYPE[t]);
    return {
      people, types: types.length ? types : ["pub"],
      balance: ["fair", "balanced", "quick"].includes(params.f) ? params.f : "balanced",
      modes: params.m != null ? { rail: params.m.includes("r"), bus: params.m.includes("b") } : { rail: true, bus: true },
      venue: params.v ? decodeURIComponent(params.v) : null,
    };
  }

  // ---------------------------------------------------------------- map

  const map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25, tap: false }).setView([51.507, -0.1278], 12);
  map.zoomControl.setPosition("bottomright");
  map.attributionControl.setPrefix(false);
  for (const [name, z] of [["basemap", 150], ["network", 330], ["heat", 340], ["crow", 360], ["routes", 420], ["casing", 410]]) {
    map.createPane(name).style.zIndex = z;
  }
  map.getPane("heat").style.pointerEvents = "none";
  map.getPane("network").style.pointerEvents = "none";

  // Hand-drawn base: boroughs and the Thames, visible wherever map tiles fail to load.
  const basemap = L.layerGroup().addTo(map);
  const thames = [];
  (function drawBasemap() {
    const B = window.HH_BASEMAP;
    if (!B) return;
    for (const [, rings] of B.boroughs) {
      L.polygon(rings.map((r) => HH.decodePolyline(r, 4)), { pane: "basemap", className: "basemap-land", weight: 1, interactive: false }).addTo(basemap);
    }
    for (const r of B.thames) {
      thames.push(L.polyline(HH.decodePolyline(r, 4), { pane: "basemap", className: "basemap-water", lineCap: "round", lineJoin: "round", interactive: false }).addTo(basemap));
    }
    const sizeRiver = () => {
      const metresPerPx = (156543.03 * Math.cos((51.5 * Math.PI) / 180)) / Math.pow(2, map.getZoom());
      for (const t of thames) t.setStyle({ weight: Math.max(3, 230 / metresPerPx) });
    };
    map.on("zoomend", sizeRiver);
    sizeRiver();
  })();
  const baseStyle = document.createElement("style");
  baseStyle.textContent = ".basemap-land{fill:var(--land);fill-opacity:1;stroke:var(--line)}.basemap-water{stroke:var(--water);fill:none}.crow-circle{stroke:var(--ink);fill:var(--ink);fill-opacity:.03}";
  document.head.appendChild(baseStyle);

  const isDark = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  let tiles = null;
  function setTiles() {
    if (tiles) map.removeLayer(tiles);
    const t = CFG.tiles || {};
    tiles = L.tileLayer(isDark() ? t.dark : t.light, { subdomains: "abcd", maxZoom: 19, attribution: t.attribution }).addTo(map);
    tiles.bringToBack();
  }
  setTiles();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { setTiles(); drawNetwork(); });
  new MutationObserver(() => { setTiles(); drawNetwork(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const lineColour = (c) => (isDark() && c === "#000000" ? "#B9C0BC" : c);

  const networkLayer = L.layerGroup();
  const canvas = L.canvas({ padding: 0.3, pane: "network" });
  function drawNetwork() {
    networkLayer.clearLayers();
    const drawn = new Set();
    for (const [, , l, , g] of E.net.edges) {
      const key = g + ":" + l;
      if (drawn.has(key)) continue;
      drawn.add(key);
      L.polyline(E.geom(g), { renderer: canvas, color: lineColour(E.lines[l].colour), weight: 2.2, opacity: isDark() ? 0.55 : 0.5, interactive: false }).addTo(networkLayer);
    }
  }
  drawNetwork();
  networkLayer.addTo(map);

  const heatLayer = L.layerGroup().addTo(map);
  const crowLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const venueLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const personMarkers = new Map();
  const venueMarkers = new Map();

  function divIcon(html, size, anchor, cls) {
    return L.divIcon({ html, className: cls || "hh-icon", iconSize: size, iconAnchor: anchor || [size[0] / 2, size[1] / 2] });
  }

  // ---------------------------------------------------------------- bottom sheet (phones)

  const panel = $("#panel");
  const scroller = $("#panelScroll");
  const SNAPS = [0.3, 0.56, 0.92];
  let sheetFrac = 0.56;
  function setSheet(frac, animate) {
    if (!mq.matches) return;
    sheetFrac = frac;
    panel.classList.toggle("is-dragging", animate === false);
    const px = Math.round(window.innerHeight * frac);
    document.documentElement.style.setProperty("--sheet-h", px + "px");
  }
  function sheetPx() { return mq.matches ? Math.round(window.innerHeight * sheetFrac) : 0; }
  (function sheetDrag() {
    const handle = $("#sheetHandle");
    let startY = 0, startFrac = 0, dragging = false, moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (!mq.matches) return;
      dragging = true; moved = false; startY = e.clientY; startFrac = sheetFrac;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 4) moved = true;
      setSheet(Math.min(0.95, Math.max(0.16, startFrac + dy / window.innerHeight)), false);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        const i = SNAPS.findIndex((s) => Math.abs(s - startFrac) < 0.05);
        setSheet(SNAPS[(i + 1) % SNAPS.length]);
      } else {
        setSheet(SNAPS.reduce((a, b) => (Math.abs(b - sheetFrac) < Math.abs(a - sheetFrac) ? b : a)));
      }
      setTimeout(() => map.invalidateSize(), 300);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const i = SNAPS.indexOf(sheetFrac);
        setSheet(SNAPS[(i + 1) % SNAPS.length]);
      }
    });
    mq.addEventListener("change", () => { if (mq.matches) setSheet(sheetFrac); map.invalidateSize(); });
    window.addEventListener("resize", () => { if (mq.matches) setSheet(sheetFrac, false); });
    setSheet(sheetFrac, false);
  })();

  function fitTo(latlngs, maxZoom) {
    if (!latlngs.length) return;
    const b = L.latLngBounds(latlngs);
    const pad = mq.matches ? { paddingTopLeft: [24, 64], paddingBottomRight: [24, sheetPx() + 24] } : { paddingTopLeft: [48, 70], paddingBottomRight: [48, 48] };
    map.fitBounds(b, Object.assign({ maxZoom: maxZoom || 15, animate: true }, pad));
  }

  // ---------------------------------------------------------------- toast

  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- people UI

  const peopleEl = $("#people");

  function renderPeople() {
    recolour();
    peopleEl.innerHTML = state.people.map((p) => `
      <li class="person${state.picking === p.id ? " is-picking" : ""}" data-id="${p.id}" style="--pc:${p.colour}">
        <span class="badge-person" aria-hidden="true">${esc(initial(p))}</span>
        <input class="person-name" id="name-${p.id}" value="${esc(p.name)}" placeholder="Person ${p.letter}" aria-label="Name for person ${p.letter}" maxlength="40" autocomplete="off">
        <button type="button" class="remove-btn" data-act="remove" aria-label="Remove ${esc(displayName(p))}">${icon("i-x")}</button>
        <div class="where">
          <input class="where-input${p.place ? "" : " is-unset"}" id="where-${p.id}" value="${esc(p.place ? p.place.label : "")}" placeholder="Station, postcode or address" aria-label="Where ${esc(displayName(p))} is starting from" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest-${p.id}">
          <button type="button" class="where-tool" data-act="pick" aria-pressed="${state.picking === p.id}" aria-label="Choose on the map" title="Choose on the map">${icon("i-pin")}</button>
          <button type="button" class="where-tool" data-act="locate" aria-label="Use my location" title="Use my location">${icon("i-locate")}</button>
          <ul class="suggest" id="suggest-${p.id}" role="listbox" hidden></ul>
        </div>
        <div class="where-meta">${p.place ? esc(p.place.sub || "") : ""}</div>
      </li>`).join("");
    $("#addPerson").hidden = state.people.length >= MAX_PEOPLE;
    $("#exampleTag").hidden = !state.example;
    renderPersonMarkers();
  }

  function renderPersonMarkers() {
    markerLayer.clearLayers();
    personMarkers.clear();
    for (const p of state.people) {
      if (!p.place) continue;
      const m = L.marker([p.place.lat, p.place.lon], {
        icon: divIcon(`<div class="pm" style="--pc:${p.colour}">${esc(initial(p))}</div>`, [34, 34], null, "pm-wrap"),
        draggable: true, keyboard: false, title: `${displayName(p)} · ${p.place.label}`, zIndexOffset: 500, riseOnHover: true,
      }).addTo(markerLayer);
      m.on("dragend", () => {
        const ll = m.getLatLng();
        setPlace(p, pinPlace(ll.lat, ll.lng));
      });
      personMarkers.set(p.id, m);
    }
  }

  function pinPlace(lat, lon) {
    const near = E.nearestStation(lat, lon);
    const label = near && near.d < 1200 ? `Near ${near.station.name}` : "Dropped pin";
    return { label, sub: `Pinned on the map${near ? ` · ${(near.d / 1000).toFixed(1)} km from ${near.station.name}` : ""}`, lat, lon, kind: "pin" };
  }

  function setPlace(p, place) {
    p.place = place;
    state.example = false;
    renderPeople();
    recompute({ fit: true });
  }

  peopleEl.addEventListener("input", (e) => {
    const li = e.target.closest(".person");
    if (!li) return;
    const p = state.people.find((x) => x.id === +li.dataset.id);
    if (e.target.classList.contains("person-name")) {
      p.name = e.target.value;
      state.example = false;
      $(".badge-person", li).textContent = initial(p);
      const m = personMarkers.get(p.id);
      if (m) m.setIcon(divIcon(`<div class="pm" style="--pc:${p.colour}">${esc(initial(p))}</div>`, [34, 34], null, "pm-wrap"));
      save();
      scheduleRender();
    } else if (e.target.classList.contains("where-input")) {
      suggestFor(p, li, e.target.value);
    }
  });

  peopleEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    const li = e.target.closest(".person");
    if (!btn || !li) return;
    const p = state.people.find((x) => x.id === +li.dataset.id);
    const act = btn.dataset.act;
    if (act === "remove") {
      state.people = state.people.filter((x) => x !== p);
      if (!state.people.length) state.people.push(person({}));
      state.example = false;
      if (state.picking === p.id) stopPicking();
      renderPeople();
      recompute({ fit: true });
    } else if (act === "pick") {
      state.picking === p.id ? stopPicking() : startPicking(p);
    } else if (act === "locate") {
      locate(p);
    }
  });

  peopleEl.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("where-input")) return;
    const li = e.target.closest(".person");
    const list = $(".suggest", li);
    const items = [...list.querySelectorAll("li[data-i]")];
    let i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      i = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items.forEach((x, j) => x.setAttribute("aria-selected", j === i ? "true" : "false"));
      e.target.setAttribute("aria-activedescendant", items[i].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = items[i >= 0 ? i : 0];
      if (pick) pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else if (e.key === "Escape") {
      closeSuggest(li);
    }
  });

  peopleEl.addEventListener("focusin", (e) => {
    if (e.target.classList.contains("where-input") || e.target.classList.contains("person-name")) {
      if (mq.matches && sheetFrac < 0.9) setSheet(0.92);
    }
    if (e.target.classList.contains("where-input")) e.target.select();
  });
  peopleEl.addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("where-input")) return;
    const li = e.target.closest(".person");
    setTimeout(() => {
      closeSuggest(li);
      const p = state.people.find((x) => x.id === +li.dataset.id);
      if (p && p.place && document.activeElement !== e.target) e.target.value = p.place.label;
    }, 150);
  });

  const suggestState = new Map();
  const KIND_ICON = { station: "i-train", postcode: "i-pin", area: "i-pin", address: "i-pin", coords: "i-pin", venue: "i-pin" };

  function closeSuggest(li) {
    if (!li) return;
    const list = $(".suggest", li);
    if (list) list.hidden = true;
    const input = $(".where-input", li);
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function suggestFor(p, li, query) {
    const list = $(".suggest", li);
    const input = $(".where-input", li);
    const q = query.trim();
    const st = suggestState.get(p.id) || {};
    clearTimeout(st.timer);
    const seq = (st.seq || 0) + 1;
    suggestState.set(p.id, { seq, timer: 0 });
    if (!q) { list.hidden = true; return; }
    const local = S.searchLocal(q, 7);
    const draw = (remote, note) => {
      const items = local.concat((remote || []).filter((r) => !local.some((l) => l.label === r.label && Math.abs(l.lat - r.lat) < 0.002)));
      list.innerHTML = items.map((it, i) => `
        <li id="sg-${p.id}-${i}" data-i="${i}" role="option" aria-selected="false">
          <span class="s-icon">${icon(KIND_ICON[it.kind] || "i-pin")}</span>
          <span class="s-label">${esc(it.label)}</span>
          <span class="s-sub">${esc(it.sub || "")}</span>
        </li>`).join("") + (note ? `<li class="s-note">${esc(note)}</li>` : "") + (!items.length && !note ? `<li class="s-note">No matches yet. Try a station, a postcode like SE1 9GF, or a street.</li>` : "");
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      list.onmousedown = (ev) => {
        const opt = ev.target.closest("li[data-i]");
        if (!opt) return;
        ev.preventDefault();
        const it = items[+opt.dataset.i];
        closeSuggest(li);
        setPlace(p, { label: it.label, sub: it.sub, lat: it.lat, lon: it.lon, kind: it.kind });
        input.blur();
      };
    };
    draw(null, q.length >= 3 ? "Searching addresses…" : "");
    if (q.length < 3 && !/^[a-z]{1,2}\d/i.test(q)) return;
    const timer = setTimeout(async () => {
      try {
        const remote = await S.searchRemote(q);
        if (suggestState.get(p.id).seq !== seq) return;
        draw(remote, "");
      } catch (err) {
        if (suggestState.get(p.id).seq !== seq) return;
        draw(null, local.length ? "" : "Address search is unavailable right now. Stations, postcodes and places still work.");
      }
    }, 320);
    suggestState.set(p.id, { seq, timer });
  }

  function locate(p) {
    if (!navigator.geolocation) { toast("Location isn't available in this browser"); return; }
    toast("Finding you…");
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (lat < HH.LONDON.south || lat > HH.LONDON.north || lon < HH.LONDON.west || lon > HH.LONDON.east) {
        toast("You seem to be outside London. Search for a starting point instead.");
        return;
      }
      const near = E.nearestStation(lat, lon);
      setPlace(p, { label: "My location", sub: near ? `Near ${near.station.name}` : "Current location", lat, lon, kind: "gps" });
      toast("Location set");
    }, () => toast("Couldn't get your location. Search or pin it on the map instead."), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function startPicking(p) {
    state.picking = p.id;
    $("#pinBannerText").textContent = `Tap the map where ${displayName(p)} is starting`;
    $("#pinBanner").hidden = false;
    map.getContainer().style.cursor = "crosshair";
    renderPeople();
    if (mq.matches) setSheet(0.3);
  }
  function stopPicking() {
    state.picking = null;
    $("#pinBanner").hidden = true;
    map.getContainer().style.cursor = "";
    renderPeople();
  }
  $("#pinCancel").addEventListener("click", stopPicking);
  map.on("click", (e) => {
    if (!state.picking) return;
    const p = state.people.find((x) => x.id === state.picking);
    stopPicking();
    if (p) setPlace(p, pinPlace(e.latlng.lat, e.latlng.lng));
  });
  map.on("contextmenu", (e) => {
    if (state.people.length >= MAX_PEOPLE) return;
    const empty = state.people.find((x) => !x.place);
    const p = empty || person({});
    if (!empty) state.people.push(p);
    setPlace(p, pinPlace(e.latlng.lat, e.latlng.lng));
    toast(`Added ${displayName(p)} here`);
  });

  $("#addPerson").addEventListener("click", () => {
    if (state.people.length >= MAX_PEOPLE) return;
    const p = person({});
    state.people.push(p);
    state.example = false;
    renderPeople();
    const input = $(`#where-${p.id}`);
    if (input) input.focus();
  });
  function startFresh() {
    state.people = [person({}), person({})];
    state.example = false;
    state.selected = null;
    state.editing = true;
    renderPeople();
    recompute({ fit: false });
    setEditing(true);
  }
  $("#clearExample").addEventListener("click", startFresh);

  // ---------------------------------------------------------------- group summary (planner collapsed)

  function renderGroup() {
    const ppl = located();
    const el = $("#groupSummary");
    const names = ppl.map(displayName);
    const nameText = names.length <= 2 ? names.join(" & ") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
    el.innerHTML = `
      <span class="avatars" aria-hidden="true">${ppl.map((p) => `<span style="--pc:${p.colour}">${esc(initial(p))}</span>`).join("")}</span>
      <span class="group-names">${esc(nameText || "Nobody yet")}</span>
      <span class="group-where">${esc(ppl.map((p) => p.place.label).join(" · "))}</span>
      <button type="button" class="chip-btn" id="editGroup">Edit</button>
      ${state.example ? `<div class="group-example">This is an example group. <button type="button" class="link-btn" data-act="fresh">Start with your own</button></div>` : ""}`;
  }

  function setEditing(on) {
    state.editing = on;
    renderAll();
    if (on) {
      const empty = state.people.find((p) => !p.place) || state.people[0];
      if (mq.matches) setSheet(0.92);
      scroller.scrollTo({ top: 0 });
      if (empty && !empty.place) setTimeout(() => { const i = $(`#where-${empty.id}`); if (i) i.focus(); }, 50);
    } else {
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      if (mq.matches) setSheet(0.56);
      const ppl = located();
      if (ppl.length) fitTo(ppl.map((p) => [p.place.lat, p.place.lon]).concat(state.fair && !state.fair.single ? [[state.fair.lat, state.fair.lon]] : []), 14);
    }
  }

  $("#groupSummary").addEventListener("click", (e) => {
    if (e.target.closest("#editGroup")) setEditing(true);
    else if (e.target.closest("[data-act=fresh]")) startFresh();
  });
  $("#doneBtn").addEventListener("click", () => {
    if (!located().length) { toast("Add at least one starting point first"); return; }
    setEditing(false);
  });

  // ---------------------------------------------------------------- types and options

  function renderTypes() {
    $("#types").innerHTML = TYPES.map((t) => `
      <button type="button" class="type-chip" data-type="${t.id}" aria-pressed="${state.types.has(t.id)}"${t.live ? ' title="Looked up live from OpenStreetMap"' : ""}>
        ${icon(t.icon)}<span>${t.label}</span>${t.live ? '<span class="live-dot" aria-hidden="true"></span>' : ""}
      </button>`).join("");
  }
  $("#types").addEventListener("click", (e) => {
    const b = e.target.closest(".type-chip");
    if (!b) return;
    const t = b.dataset.type;
    if (state.types.has(t)) state.types.delete(t); else state.types.add(t);
    b.setAttribute("aria-pressed", state.types.has(t));
    state.selected = null;
    recompute({ fit: false });
  });

  function renderOptions() {
    for (const b of document.querySelectorAll("#balance button")) b.setAttribute("aria-checked", b.dataset.v === state.balance);
    $("#modeRail").checked = state.modes.rail;
    $("#modeBus").checked = state.modes.bus;
    const bal = { fair: "Nobody travels far", balanced: "Balanced", quick: "Least travel" }[state.balance];
    const modes = [state.modes.rail && "rail", state.modes.bus && "bus"].filter(Boolean).join(" & ") || "walking only";
    const when = state.when ? `by ${state.when.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "now";
    $("#optionsSummary").textContent = `${bal} · ${modes} · ${when}`;
  }
  $("#balance").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    state.balance = b.dataset.v;
    renderOptions();
    recompute({ fit: false });
  });
  $("#modeRail").addEventListener("change", (e) => { state.modes.rail = e.target.checked; renderOptions(); recompute({ fit: false }); });
  $("#modeBus").addEventListener("change", (e) => { state.modes.bus = e.target.checked; renderOptions(); recompute({ fit: false }); });
  $("#when").addEventListener("change", (e) => {
    const v = e.target.value;
    state.when = v ? new Date(v) : null;
    if (state.when && isNaN(state.when)) state.when = null;
    renderOptions();
    scheduleLiveCheck(true);
    renderAll();
  });
  $("#whenNow").addEventListener("click", () => { $("#when").value = ""; state.when = null; renderOptions(); scheduleLiveCheck(true); renderAll(); });

  // ---------------------------------------------------------------- compute

  function liveBox() {
    const f = state.fair;
    if (!f) return null;
    const multi = located().length > 1;
    const dLat = multi ? 0.022 : 0.016, dLon = multi ? 0.036 : 0.026;
    return { south: f.lat - dLat, north: f.lat + dLat, west: f.lon - dLon, east: f.lon + dLon };
  }

  function liveVenueList() {
    const out = [];
    for (const t of state.types) {
      if (!TYPE[t].live) continue;
      const entry = state.liveTypes.get(t);
      if (entry && entry.status === "ok") out.push(...entry.list);
    }
    return out;
  }

  function ensureLiveTypes() {
    const box = liveBox();
    if (!box) return;
    for (const t of state.types) {
      if (!TYPE[t].live) continue;
      const key = [box.south, box.west].map((x) => x.toFixed(2)).join(",");
      const entry = state.liveTypes.get(t);
      if (entry && entry.key === key && entry.status !== "error") continue;
      if (entry && entry.key === key && entry.status === "error" && Date.now() - entry.at < 30000) continue;
      const rec = { key, status: "loading", list: [], at: Date.now() };
      state.liveTypes.set(t, rec);
      S.liveVenues(t, box).then((list) => {
        rec.status = "ok";
        rec.list = list;
        if (state.liveTypes.get(t) === rec) recompute({ fit: false, keepLive: true });
      }, () => {
        rec.status = "error";
        if (state.liveTypes.get(t) === rec) renderAll();
      });
    }
  }

  function venueKey(v) { return typeof v.id === "number" ? `v${v.id}` : v.id; }
  function liveKey(v, p) {
    const w = state.when ? state.when.getTime() : "now";
    return `${venueKey(v)}|${p.place.lat.toFixed(4)},${p.place.lon.toFixed(4)}|${w}|${state.modes.rail ? 1 : 0}${state.modes.bus ? 1 : 0}`;
  }

  /** Journey times for one result: live from TfL where we have them, estimates otherwise. */
  function timesFor(result) {
    const ppl = located();
    return ppl.map((p, i) => {
      const rec = state.live.get(liveKey(result.venue, p));
      if (rec && rec.status === "ok" && rec.journeys.length) return { mins: rec.journeys[0].mins, live: true };
      return { mins: result.times[i], live: false, loading: rec && rec.status === "loading" };
    });
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAll(); });
  }

  function recompute(opts) {
    const o = opts || {};
    const ppl = located();
    save();
    if (!ppl.length || !state.types.size) {
      state.fields = state.fair = state.crow = state.ranking = null;
      state.selected = null;
      renderAll();
      drawMapResults();
      return;
    }
    state.fields = ppl.map((p) => E.timeField({ lat: p.place.lat, lon: p.place.lon, name: p.place.label }, { modes: state.modes }));
    if (ppl.length > 1) {
      state.fair = E.fairPoint(state.fields);
    } else {
      const p = ppl[0].place;
      state.fair = { lat: p.lat, lon: p.lon, times: [0], worst: 0, single: true, box: E.searchBox([p]) };
    }
    state.crow = ppl.length > 1 ? HH.minEnclosingCircle(ppl.map((p) => p.place)) : null;
    state.crowWorst = state.crow ? Math.max(...state.fields.map((f) => E.travel(f, state.crow.lat, state.crow.lon).mins)) : null;
    ensureLiveTypes();
    const ranking = E.rankVenues(state.fields, [...state.types], { balance: state.balance, extra: liveVenueList(), limit: 8 });
    state.ranking = ranking;
    if (state.selected) {
      const again = ranking.results.find((r) => venueKey(r.venue) === venueKey(state.selected.venue));
      state.selected = again || null;
    }
    renderAll();
    drawMapResults();
    if (o.fit) fitTo(ppl.map((p) => [p.place.lat, p.place.lon]).concat(state.fair && !state.fair.single ? [[state.fair.lat, state.fair.lon]] : []), ppl.length === 1 ? 14 : 14);
    scheduleLiveCheck(false);
  }

  // ---------------------------------------------------------------- live journeys

  function checkVenue(result) {
    const ppl = located();
    const jobs = [];
    for (const p of ppl) {
      const key = liveKey(result.venue, p);
      const have = state.live.get(key);
      if (have && (have.status === "ok" || have.status === "loading")) continue;
      if (have && have.status === "error" && Date.now() - have.at < 20000) continue;
      const rec = { status: "loading", journeys: [], at: Date.now() };
      state.live.set(key, rec);
      jobs.push(S.tflJourneys(p.place, { lat: result.venue.lat, lon: result.venue.lon }, { rail: state.modes.rail, bus: state.modes.bus, when: state.when })
        .then((js) => { rec.status = "ok"; rec.journeys = js; }, (err) => { rec.status = "error"; rec.error = err; rec.at = Date.now(); })
        .finally(scheduleRender));
    }
    scheduleRender();
    return Promise.all(jobs);
  }

  function scheduleLiveCheck(now) {
    clearTimeout(state.liveCheckTimer);
    state.liveCheckTimer = setTimeout(async () => {
      if (!state.ranking || !state.ranking.results.length) return;
      if (state.selected) checkVenue(state.selected);
      const top = state.ranking.results.slice(0, 3);
      await Promise.all(top.map(checkVenue));
      // Re-order using live times where TfL answered.
      if (!state.ranking) return;
      const scored = state.ranking.results.map((r) => {
        const t = timesFor(r);
        return { r, s: E.score(t.map((x) => x.mins), state.balance) - (r.venue.q / 9) * 3, anyLive: t.some((x) => x.live) };
      });
      if (!scored.some((x) => x.anyLive)) return;
      const before = state.ranking.results.map((r) => venueKey(r.venue)).join();
      const head = scored.slice(0, 3).sort((a, b) => a.s - b.s).map((x) => x.r);
      state.ranking.results = head.concat(state.ranking.results.slice(3));
      if (state.ranking.results.map((r) => venueKey(r.venue)).join() !== before) {
        renderAll();
        drawMapResults();
      }
    }, now ? 50 : 650);
  }

  // ---------------------------------------------------------------- results UI

  const resultsEl = $("#results");
  const detailEl = $("#detail");

  function typeList() {
    const names = [...state.types].map((t) => PLURAL[t]);
    if (names.length <= 2) return names.join(" and ");
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  function rulerHtml(times, scaleMax, ticks) {
    const ppl = located();
    const pos = (m) => `${Math.min(100, (m / scaleMax) * 100).toFixed(2)}%`;
    const mins = times.map((t) => t.mins);
    const lo = Math.min(...mins), hi = Math.max(...mins);
    let html = `<span class="ruler${ticks ? " has-ticks" : ""}" aria-hidden="true"><span class="ruler-track"></span>`;
    if (ppl.length > 1) html += `<span class="ruler-span" style="left:${pos(lo)};width:calc(${pos(hi)} - ${pos(lo)})"></span>`;
    times.forEach((t, i) => { html += `<span class="ruler-dot" style="left:${pos(t.mins)};--pc:${ppl[i].colour}" title="${esc(displayName(ppl[i]))}: ${fmtMins(t.mins)} min"></span>`; });
    if (ticks) {
      const step = scaleMax <= 40 ? 10 : scaleMax <= 80 ? 15 : 30;
      for (let m = 0; m <= scaleMax; m += step) html += `<span class="ruler-tick" style="left:${pos(m)}">${m}${m === 0 ? "" : ""}</span>`;
    }
    return html + "</span>";
  }

  function nearestName(lat, lon) {
    const n = E.nearestStation(lat, lon);
    return n ? n.station : null;
  }

  function renderResults() {
    const ppl = located();
    if (!state.types.size) {
      resultsEl.innerHTML = `<div class="empty"><b>Pick at least one kind of place</b> to see suggestions.</div>`;
      return;
    }
    if (!ppl.length) {
      resultsEl.innerHTML = `<div class="empty"><b>Add where everyone's starting from.</b> Type a station, a postcode or an address, tap the pin to choose a spot on the map, or long-press the map to add someone there.</div>`;
      return;
    }
    const r = state.ranking;
    const fair = state.fair;
    let html = "";
    if (ppl.length > 1) {
      const st = nearestName(fair.lat, fair.lon);
      const crowSt = state.crow ? nearestName(state.crow.lat, state.crow.lon) : null;
      const lo = Math.min(...fair.times), hi = Math.max(...fair.times);
      html += `
        <div class="verdict">
          <div class="verdict-kicker">Fairest spot by transport</div>
          <div class="verdict-title">${st ? `Around ${esc(st.name)}` : "Somewhere central"}</div>
          <p class="verdict-text">From here everyone's journey is about ${fmtMins(lo)}${Math.round(hi) !== Math.round(lo) ? `–${fmtMins(hi)}` : ""} min${st && st.zone ? ` (Zone ${esc(st.zone)})` : ""}.</p>
          <dl class="verdict-points">
            <div><dt><span class="key-fair"></span>By transport</dt><dd>Longest trip ${fmtMins(fair.worst)} min</dd></div>
            ${state.crow ? `<div><dt><span class="key-crow"></span>Crow flies</dt><dd>${crowSt ? `Near ${esc(crowSt.name)}, ` : ""}${(state.crow.radius / 1000).toFixed(1)} km from the furthest person. Longest trip there ${fmtMins(state.crowWorst)} min</dd></div>` : ""}
          </dl>
        </div>`;
    }
    const liveNotes = [...state.types].filter((t) => TYPE[t].live).map((t) => [t, state.liveTypes.get(t)]);
    const loadingLive = liveNotes.filter(([, e]) => e && e.status === "loading").map(([t]) => PLURAL[t]);
    const failedLive = liveNotes.filter(([, e]) => e && e.status === "error").map(([t]) => PLURAL[t]);
    html += `<div class="results-head"><h2>${ppl.length > 1 ? "Places to meet" : `Closest ${esc(typeList())}`}</h2><span class="hint">${r ? `${r.considered.toLocaleString("en-GB")} ${esc(typeList())} compared` : ""}</span></div>`;
    if (!r || !r.results.length) {
      html += `<div class="empty">${loadingLive.length ? `Looking up ${esc(loadingLive.join(" and "))} near the middle…` : `<b>Nothing suitable nearby.</b> Try another kind of place.`}</div>`;
    } else {
      const all = r.results.map((x) => timesFor(x));
      const worstAll = Math.max(...all.flat().map((t) => t.mins));
      const scaleMax = Math.max(30, Math.ceil(worstAll / 10) * 10);
      html += `<ol class="venues">` + r.results.map((x, i) => {
        const times = all[i];
        const worst = Math.max(...times.map((t) => t.mins));
        const live = times.every((t) => t.live);
        const busy = times.some((t) => t.loading);
        const t = TYPE[x.venue.type];
        const sel = state.selected && venueKey(state.selected.venue) === venueKey(x.venue);
        return `<li><button type="button" class="venue${sel ? " is-selected" : ""}" data-k="${esc(venueKey(x.venue))}">
          <span class="venue-rank">${i + 1}</span>
          <span class="venue-name">${esc(x.venue.name)}</span>
          <span class="venue-time"><b>${fmtMins(worst)}</b><span>${ppl.length > 1 ? "MIN MAX" : "MIN"}</span></span>
          <span class="venue-meta">${icon(t.icon)}<span class="addr">${esc(x.venue.address || t.label)}</span>${busy ? `<span class="badge badge-busy">Checking</span>` : live ? `<span class="badge badge-live">Live</span>` : `<span class="badge">Estimate</span>`}</span>
          ${rulerHtml(times, scaleMax, i === 0)}
        </button></li>`;
      }).join("") + `</ol>`;
    }
    if (loadingLive.length && r && r.results.length) html += `<p class="notice">Still looking up ${esc(loadingLive.join(" and "))} from OpenStreetMap…</p>`;
    if (failedLive.length) html += `<p class="notice">Couldn't reach OpenStreetMap for ${esc(failedLive.join(" and "))} just now. Other kinds of place still work.</p>`;
    if (S.tflDown) html += `<p class="notice">Live TfL times aren't reachable from here, so times are Halfway House's own estimates from the rail network, buses and walking.</p>`;
    resultsEl.innerHTML = html;
  }

  resultsEl.addEventListener("click", (e) => {
    const b = e.target.closest(".venue");
    if (!b) return;
    const res = state.ranking.results.find((x) => venueKey(x.venue) === b.dataset.k);
    if (res) select(res);
  });
  resultsEl.addEventListener("mouseover", (e) => {
    const b = e.target.closest(".venue");
    highlightVenue(b ? b.dataset.k : null);
  });
  resultsEl.addEventListener("mouseleave", () => highlightVenue(null));

  function highlightVenue(k) {
    for (const [key, m] of venueMarkers) {
      const el = m.getElement();
      if (el) el.style.transform = el.style.transform.replace(/ scale\([^)]*\)/, "") + (key === k ? " scale(1.2)" : "");
      if (key === k) m.setZIndexOffset(800); else m.setZIndexOffset(0);
    }
  }

  function select(res) {
    state.selected = res;
    checkVenue(res);
    renderAll();
    drawMapResults();
    scroller.scrollTo({ top: 0, behavior: "smooth" });
    if (mq.matches) setSheet(0.56);
    fitRoutes();
  }
  function deselect() {
    state.selected = null;
    renderAll();
    drawMapResults();
    const ppl = located();
    fitTo(ppl.map((p) => [p.place.lat, p.place.lon]).concat(state.fair && !state.fair.single ? [[state.fair.lat, state.fair.lon]] : []), 14);
  }

  // ---------------------------------------------------------------- detail UI

  function legLabel(leg) {
    const line = leg.line || "";
    switch (leg.mode) {
      case "walk": return "Walk";
      case "cycle": return "Cycle";
      case "bus": return `Bus ${line}`;
      case "tube": return /line$/i.test(line) ? line : `${line} line`;
      case "overground": return /overground|line$/i.test(line) ? line : `${line} line`;
      case "elizabeth-line": return "Elizabeth line";
      case "dlr": return "DLR";
      case "tram": return "Tram";
      case "cable-car": return "Cable car";
      case "river-bus": return `Boat ${line}`;
      case "national-rail": return line && line !== "National Rail" ? `${line} train` : "Train";
      default: return line || leg.mode;
    }
  }
  function legIcon(leg) {
    if (leg.mode === "walk") return "i-walk";
    if (leg.mode === "bus" || leg.mode === "coach") return "i-bus";
    if (leg.mode === "river-bus") return "i-boat";
    if (leg.mode === "cycle") return "i-cycle";
    return "i-train";
  }
  const BUS_RED = "#D9381E";
  function legColour(leg, p) {
    if (leg.mode === "walk" || leg.mode === "cycle") return p.colour;
    if (leg.mode === "bus") return leg.colour || BUS_RED;
    return lineColour(leg.colour || "#5B6770");
  }

  /** The journey we show for a person: chosen TfL option, or our own estimate. */
  function journeyFor(res, p, i) {
    const rec = state.live.get(liveKey(res.venue, p));
    if (rec && rec.status === "ok" && rec.journeys.length) {
      const k = liveKey(res.venue, p);
      const idx = Math.min(state.chosen.get(k) || 0, rec.journeys.length - 1);
      return { journey: rec.journeys[idx], options: rec.journeys, idx, rec };
    }
    const est = E.route(state.fields[i], res.venue.lat, res.venue.lon, res.venue.name);
    est.legs.forEach((l) => {
      if (l.line && !l.colour) l.colour = "#5B6770";
      if (l.mode === "national-rail") l.line = "National Rail";
    });
    return { journey: est, options: [], idx: 0, rec };
  }

  function stripHtml(journey, p) {
    const total = journey.legs.reduce((s, l) => s + Math.max(1, l.mins), 0);
    return `<div class="strip" aria-hidden="true">` + journey.legs.map((l) => {
      const w = Math.max(1, l.mins) / total;
      const label = w > 0.12 ? `<span>${l.mode === "bus" ? esc(l.line || "") : fmtMins(l.mins)}</span>` : "";
      return `<span class="strip-seg ${l.mode === "walk" || l.mode === "cycle" ? "walk" : ""}" style="flex:${w.toFixed(3)};--seg:${legColour(l, p)}">${l.mode === "walk" ? label : w > 0.12 ? `${icon(legIcon(l))}${label}` : icon(legIcon(l))}</span>`;
    }).join("") + `</div>`;
  }

  function legsHtml(journey, p, venue) {
    return `<ol class="legs">` + journey.legs.map((l, i) => {
      const last = i === journey.legs.length - 1;
      let title, sub = "";
      if (l.mode === "walk") {
        title = `Walk to ${esc(last ? venue.name : l.to && l.to.name ? l.to.name : "the next stop")}`;
        if (l.transfer) title = `Walk to ${esc(l.to.name)} to change`;
      } else if (l.mode === "cycle") {
        title = `Cycle to ${esc(l.to && l.to.name)}`;
      } else if (l.mode === "bus" && l.estimated) {
        title = last ? `Bus towards ${esc(venue.name)}` : `Bus to ${esc(l.to.name)}`;
        sub = "Several routes could work; check live times";
      } else {
        title = `<b>${esc(legLabel(l))}</b>${l.direction ? ` towards ${esc(l.direction)}` : ""}`;
        const parts = [];
        if (l.from && l.from.name && l.to && l.to.name) parts.push(`${esc(l.from.name)} → ${esc(l.to.name)}`);
        if (l.stops) parts.push(`${l.stops} stop${l.stops === 1 ? "" : "s"}`);
        if (l.changeAt) parts.unshift(`Change at ${esc(l.changeAt.name)}`);
        sub = parts.join(" · ");
        if (l.disrupted) sub += ` · <b>Disruption reported</b>`;
      }
      return `<li class="leg"><span class="leg-icon ${l.mode === "walk" ? "walk" : ""}" style="--seg:${legColour(l, p)}">${icon(legIcon(l))}</span>
        <span class="leg-text">${title}${sub ? `<small>${sub}</small>` : ""}</span>
        <span class="leg-mins">${fmtMins(l.mins)} min</span></li>`;
    }).join("") + `</ol>`;
  }

  function timing(journey) {
    if (!journey.estimated && journey.start) {
      const s = new Date(journey.start), e = new Date(journey.end);
      if (!isNaN(s)) return `Leave ${fmtClock(s)}, arrive ${fmtClock(e)}`;
    }
    if (state.when) return `Leave about ${fmtClock(new Date(state.when.getTime() - journey.mins * 60000))}`;
    return `Arrive about ${fmtClock(new Date(Date.now() + journey.mins * 60000))} if you leave now`;
  }

  function renderDetail() {
    const res = state.selected;
    if (!res) { detailEl.hidden = true; detailEl.innerHTML = ""; return; }
    const ppl = located();
    const v = res.venue;
    const t = TYPE[v.type];
    const times = timesFor(res);
    const mins = times.map((x) => x.mins);
    const flags = v.type === "pub" ? PUB_FLAGS.filter(([bit]) => v.flags & bit).map(([, label]) => label) : [];
    const rank = state.ranking.results.indexOf(res) + 1;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address || ""}`.trim())}`;
    let html = `
      <div class="detail-top"><button type="button" class="back-btn" id="backBtn">${icon("i-back")}All suggestions</button></div>
      <h2 class="detail-title">${esc(v.name)}</h2>
      <p class="detail-sub"><span>${icon(t.icon)} ${esc(t.label)}${rank ? ` · suggestion ${rank}` : ""}</span>${v.address ? `<span>${esc(v.address)}</span>` : ""}</p>
      ${flags.length ? `<div class="flags">${flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</div>` : ""}
      <div class="detail-actions">
        <button type="button" class="btn primary" id="shareBtn">${icon("i-share")}Share plan</button>
        <button type="button" class="btn" id="copyBtn">${icon("i-copy")}Copy text</button>
        <a class="btn" href="${esc(mapsUrl)}" target="_blank" rel="noopener">${icon("i-ext")}Map</a>
        ${safeUrl(v.url) ? `<a class="btn" href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener">${icon("i-ext")}Website</a>` : ""}
      </div>`;
    if (ppl.length > 1) {
      const avg = mins.reduce((a, b) => a + b, 0) / mins.length;
      html += `<dl class="detail-summary">
        <div><dt>Longest</dt><dd>${fmtMins(Math.max(...mins))} min</dd></div>
        <div><dt>Average</dt><dd>${fmtMins(avg)} min</dd></div>
        <div><dt>Gap</dt><dd>${fmtMins(Math.max(...mins) - Math.min(...mins))} min</dd></div>
      </dl>`;
    }
    html += `<ol class="journeys">` + ppl.map((p, i) => {
      const { journey, options, idx, rec } = journeyFor(res, p, i);
      const loading = rec && rec.status === "loading";
      const note = loading ? "Checking TfL for live times…"
        : journey.estimated ? (rec && rec.status === "error" ? "Estimate: TfL couldn't be reached." : "Estimate.") + " Times include walking to the platform, waiting and changing."
        : journey.fare ? `Pay as you go fare about £${(journey.fare / 100).toFixed(2)}.` : "";
      const cm = `https://citymapper.com/directions?startcoord=${p.place.lat},${p.place.lon}&endcoord=${v.lat},${v.lon}&endname=${encodeURIComponent(v.name)}`;
      const gm = `https://www.google.com/maps/dir/?api=1&origin=${p.place.lat},${p.place.lon}&destination=${v.lat},${v.lon}&travelmode=transit`;
      return `<li class="journey" style="--pc:${p.colour}">
        <div class="journey-head">
          <span class="badge-person">${esc(initial(p))}</span>
          <span class="journey-who">${esc(displayName(p))}</span>
          <span class="journey-mins"><b>${fmtMins(journey.mins)}</b> min<span>${journey.estimated ? "estimate" : "live"}</span></span>
          <span class="journey-from">from ${esc(p.place.label)}</span>
        </div>
        <div class="journey-when">${esc(timing(journey))}</div>
        ${stripHtml(journey, p)}
        ${legsHtml(journey, p, v)}
        ${options.length > 1 ? `<div class="options-tabs" role="group" aria-label="Route options">${options.map((o, k) => `<button type="button" data-person="${p.id}" data-opt="${k}" aria-pressed="${k === idx}">${k === 0 ? "Fastest" : `Option ${k + 1}`} · ${fmtMins(o.mins)} min${o.legs.some((l) => l.mode === "bus") && !o.legs.some((l) => l.line && l.mode !== "bus") ? " · bus" : ""}</button>`).join("")}</div>` : ""}
        ${note ? `<div class="journey-note">${esc(note)}</div>` : ""}
        <div class="journey-links"><a href="${esc(cm)}" target="_blank" rel="noopener">${icon("i-ext")}Citymapper</a><a href="${esc(gm)}" target="_blank" rel="noopener">${icon("i-ext")}Google Maps</a></div>
      </li>`;
    }).join("") + `</ol>`;
    detailEl.innerHTML = html;
    detailEl.hidden = false;
  }

  detailEl.addEventListener("click", async (e) => {
    if (e.target.closest("#backBtn")) { deselect(); return; }
    const opt = e.target.closest("button[data-opt]");
    if (opt) {
      const p = state.people.find((x) => x.id === +opt.dataset.person);
      state.chosen.set(liveKey(state.selected.venue, p), +opt.dataset.opt);
      renderAll();
      drawRoutes();
      return;
    }
    if (e.target.closest("#copyBtn")) {
      copy(planText(), "Copied. Paste it into the group chat.");
      return;
    }
    if (e.target.closest("#shareBtn")) {
      const text = planText(true);
      const url = shareUrl();
      if (navigator.share) {
        try { await navigator.share({ title: "Halfway House", text, url }); return; } catch (err) { if (err && err.name === "AbortError") return; }
      }
      copy(url, "Link copied. Anyone who opens it sees the same plan.");
    }
  });

  function planText(short) {
    const res = state.selected;
    const v = res.venue;
    const ppl = located();
    const lines = [`Let's meet at ${v.name}${v.address ? `, ${v.address}` : ""}.`];
    ppl.forEach((p, i) => {
      const { journey } = journeyFor(res, p, i);
      lines.push(`${displayName(p)}: ${fmtMins(journey.mins)} min from ${p.place.label}`);
    });
    if (!short) lines.push(shareUrl());
    return lines.join("\n");
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { /* ignore */ }
      ta.remove();
      toast(ok ? msg : "Couldn't copy automatically. Select the text and copy it yourself.");
    }
  }

  // ---------------------------------------------------------------- map drawing

  function drawMapResults() {
    heatLayer.clearLayers();
    crowLayer.clearLayers();
    venueLayer.clearLayers();
    venueMarkers.clear();
    const legend = $("#heatLegend");
    legend.hidden = true;
    const ppl = located();
    if (state.fair && ppl.length > 1) {
      if ($("#layerHeat").checked) drawHeat(state.fair);
      L.marker([state.fair.lat, state.fair.lon], {
        icon: divIcon(`<div class="fair-marker" style="width:26px;height:26px"><span class="ring"></span><span class="map-label">Fairest spot</span></div>`, [26, 26]),
        keyboard: false, interactive: false, zIndexOffset: 300,
      }).addTo(crowLayer);
      if (state.crow && $("#layerCrow").checked) {
        L.circle([state.crow.lat, state.crow.lon], { radius: state.crow.radius, pane: "crow", className: "crow-circle", weight: 1.5, dashArray: "5 7", interactive: false }).addTo(crowLayer);
        L.marker([state.crow.lat, state.crow.lon], {
          icon: divIcon(`<div class="crow-marker" style="width:18px;height:18px"><span class="x"></span><span class="map-label">As the crow flies</span></div>`, [18, 18]),
          keyboard: false, interactive: false, zIndexOffset: 200,
        }).addTo(crowLayer);
      }
    }
    if (state.ranking) {
      state.ranking.results.forEach((r, i) => {
        const k = venueKey(r.venue);
        const sel = state.selected && venueKey(state.selected.venue) === k;
        if (state.selected && !sel) return;
        const size = sel ? 36 : 28;
        const m = L.marker([r.venue.lat, r.venue.lon], {
          icon: divIcon(`<div class="vm${i === 0 ? " is-top" : ""}${sel ? " is-selected" : ""}"><span>${i + 1}</span></div>${sel ? `<span class="dest-label">${esc(r.venue.name)}</span>` : ""}`, [size, size], [size / 2, size + 2]),
          title: r.venue.name, zIndexOffset: sel ? 900 : 100 - i, keyboard: true,
        }).addTo(venueLayer);
        m.on("click", () => select(r));
        venueMarkers.set(k, m);
      });
    }
    drawRoutes();
  }

  // Bands of "how much longer is the longest trip than at the fairest spot", drawn like isochrones.
  const HEAT_BANDS = [[3, 0.42], [8, 0.2]];
  function drawHeat(fair) {
    const n = fair.cells;
    const scale = 6;
    const W = n * scale;
    const c = document.createElement("canvas");
    c.width = W; c.height = W;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(W, W);
    const best = fair.worst;
    const v = fair.values;
    const at = (r, col) => v[Math.max(0, Math.min(n - 1, r)) * n + Math.max(0, Math.min(n - 1, col))];
    for (let y = 0; y < W; y++) {
      // Canvas rows run north to south; grid rows run south to north.
      const gr = (W - 1 - y) / scale - 0.5;
      const r0 = Math.floor(gr), fr = gr - r0;
      for (let x = 0; x < W; x++) {
        const gc = x / scale - 0.5;
        const c0 = Math.floor(gc), fc = gc - c0;
        const val = (at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc) * (1 - fr) + (at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc) * fr;
        const d = val - best;
        const band = HEAT_BANDS.find(([limit]) => d <= limit);
        if (!band) continue;
        const i = (y * W + x) * 4;
        img.data[i] = 196; img.data[i + 1] = 128; img.data[i + 2] = 24;
        img.data[i + 3] = Math.round(band[1] * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    L.imageOverlay(c.toDataURL(), [[fair.box.south, fair.box.west], [fair.box.north, fair.box.east]], { pane: "heat", opacity: 1, interactive: false, className: "heat-img" }).addTo(heatLayer);
    const legend = $("#heatLegend");
    legend.innerHTML = `<b>Fairness shading</b><div class="heat-key">${HEAT_BANDS.map(([limit, a]) => `<span><i style="opacity:${(a / HEAT_BANDS[0][1]).toFixed(2)}"></i>${limit === 3 ? "Fairest" : `+${limit} min`}</span>`).join("")}</div><div class="heat-note">Longest trip ${fmtMins(best)} min at the fairest spot</div>`;
    legend.hidden = false;
  }

  function drawRoutes() {
    routeLayer.clearLayers();
    const res = state.selected;
    if (!res) return;
    const ppl = located();
    ppl.forEach((p, i) => {
      const { journey } = journeyFor(res, p, i);
      for (const leg of journey.legs) {
        if (!leg.coords || leg.coords.length < 2) continue;
        const colour = legColour(leg, p);
        if (leg.mode === "walk" || leg.mode === "cycle") {
          L.polyline(leg.coords, { pane: "routes", color: colour, weight: 4.5, opacity: 0.95, dashArray: journey.estimated ? "2 9" : "1 8", lineCap: "round", interactive: false }).addTo(routeLayer);
        } else {
          L.polyline(leg.coords, { pane: "casing", color: isDark() ? "#0C1210" : "#FFFFFF", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round", interactive: false }).addTo(routeLayer);
          L.polyline(leg.coords, { pane: "routes", color: colour, weight: 5, opacity: 1, lineCap: "round", lineJoin: "round", dashArray: leg.estimated && leg.mode === "bus" ? "8 8" : null, interactive: false }).addTo(routeLayer);
          if (leg.from && leg.from.lat) L.marker([leg.from.lat, leg.from.lon], { icon: divIcon(`<div class="stop-dot"></div>`, [10, 10]), interactive: true, keyboard: false, title: leg.from.name || "" }).addTo(routeLayer);
          if (leg.to && leg.to.lat) L.marker([leg.to.lat, leg.to.lon], { icon: divIcon(`<div class="stop-dot"></div>`, [10, 10]), interactive: true, keyboard: false, title: leg.to.name || "" }).addTo(routeLayer);
        }
      }
    });
  }

  function fitRoutes() {
    const res = state.selected;
    if (!res) return;
    const pts = [[res.venue.lat, res.venue.lon]];
    for (const p of located()) pts.push([p.place.lat, p.place.lon]);
    fitTo(pts, 15);
  }

  for (const id of ["layerHeat", "layerCrow"]) $("#" + id).addEventListener("change", drawMapResults);
  $("#layerLines").addEventListener("change", (e) => { if (e.target.checked) networkLayer.addTo(map); else map.removeLayer(networkLayer); });
  $("#layersBtn").addEventListener("click", () => {
    const menu = $("#layersMenu");
    menu.hidden = !menu.hidden;
    $("#layersBtn").setAttribute("aria-expanded", String(!menu.hidden));
  });

  // ---------------------------------------------------------------- render all

  let lastSelectedKey = null;
  function renderAll() {
    renderResults();
    renderDetail();
    const selKey = state.selected ? venueKey(state.selected.venue) : null;
    const editing = state.editing || !located().length;
    resultsEl.hidden = !!state.selected;
    $("#planner").hidden = !!state.selected || !editing;
    $("#plannerMore").hidden = !!state.selected || !editing;
    $("#kinds").hidden = !!state.selected;
    $("#kinds").classList.toggle("is-compact", !editing);
    $("#groupSummary").hidden = !!state.selected || editing;
    if (!editing && !state.selected) renderGroup();
    if (selKey !== lastSelectedKey) { lastSelectedKey = selKey; }
    renderOptions();
    if (state.selected) drawRoutes();
  }

  // ---------------------------------------------------------------- about

  const about = $("#about");
  $("#aboutBtn").addEventListener("click", () => { if (about.showModal) about.showModal(); else about.setAttribute("open", ""); });
  about.addEventListener("click", (e) => {
    if (e.target === about || e.target.closest("button[value=close]")) { e.preventDefault(); about.close ? about.close() : about.removeAttribute("open"); }
  });

  // ---------------------------------------------------------------- boot

  function boot() {
    const shared = readHash();
    const saved = loadSaved();
    let wantVenue = null;
    if (shared) {
      state.people = shared.people.map((x) => person(x));
      state.types = new Set(shared.types);
      state.balance = shared.balance;
      state.modes = shared.modes;
      wantVenue = shared.venue;
    } else if (saved && saved.people && saved.people.length && !saved.example) {
      state.people = saved.people.slice(0, MAX_PEOPLE).map((x) => person(x));
      state.types = new Set((saved.types || ["pub"]).filter((t) => TYPE[t]));
      state.balance = saved.balance || "balanced";
      state.modes = Object.assign({ rail: true, bus: true }, saved.modes);
    } else {
      state.people = exampleGroup();
      state.example = true;
    }
    state.editing = located().length < 1;
    if (!state.types.size) state.types.add("pub");
    renderTypes();
    renderPeople();
    renderOptions();
    recompute({ fit: true });
    if (wantVenue && state.ranking) {
      const hit = state.ranking.results.find((r) => r.venue.name === wantVenue);
      if (hit) select(hit);
    }
  }
  boot();

  window.addEventListener("hashchange", () => { if (readHash()) boot(); });
  window.HHApp = { state, recompute, select, E };
})();
