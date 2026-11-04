// The listings map: OpenFreeMap street tiles in the page theme, one pin per located listing colored by
// its deal tier and numbered like its card, clustered where pins crowd, with the hovered and the open
// listing marked, and everything outside the five boroughs dimmed. MapLibre loads only when the map is
// first drawn.
import { NYC_EXTENT } from "./core-model.js";
import { NYC_LIMITS, inCity } from "./nyc-boroughs.js";

const STYLES = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/positron" };
const NYC = [[NYC_EXTENT.west, NYC_EXTENT.south], [NYC_EXTENT.east, NYC_EXTENT.north]];

// Tier colors per theme: great is filled, good a ring with a soft fill, fair grey, full price the one
// hollow ring and unpriced a solid blue dot. The mask washes the land outside the city toward the page.
export const PALETTE = {
  dark: { great: "#4cc27a", goodFill: "#2b5a3d", good: "#4cc27a", fair: "#adadad", hollow: "#1c1c1c", full: "#999999", unpriced: "#6aa2e6", halo: "#121212", ink: "#f3f3f3", onInk: "#121212", mask: "#0b0b0b" },
  light: { great: "#1d7a45", goodFill: "#cfe9d9", good: "#1d7a45", fair: "#6b6b6b", hollow: "#ffffff", full: "#6b6b6b", unpriced: "#2d63a6", halo: "#ffffff", ink: "#1b1b1b", onInk: "#ffffff", mask: "#ffffff" },
};

// The whole world with the city limits cut out as holes, each wound against the outer ring so MapLibre
// reads it as a hole.
const signedArea = (ring) => ring.reduce((sum, [x1, y1], i) => {
  const [x2, y2] = ring[(i + 1) % ring.length];
  return sum + (x2 - x1) * (y2 + y1);
}, 0);
const wound = (ring, sign) => (Math.sign(signedArea(ring)) === sign ? ring : [...ring].reverse());
export function outsideCity() {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const holes = NYC_LIMITS.map((ring) => wound([...ring, ring[0]], -Math.sign(signedArea(world))));
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, ...holes] } };
}

// With no saved view the map opens on the five boroughs, fit edge to edge.
export const mapOptions = (container, mode) => ({
  container,
  style: STYLES[mode],
  bounds: NYC,
  fitBoundsOptions: { padding: 0 },
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  cooperativeGestures: false,
  trackResize: false,
});

// Pins arrive as one array per field; research before the columnar body sent one object per pin. A
// pin's rank is the number of its card.
export const pinRows = (pins) => Array.isArray(pins) ? pins : pins ? pins.id.map((id, i) => ({
  id, rank: pins.rank[i], address: pins.address[i], latitude: pins.latitude[i], longitude: pins.longitude[i], dealVerdict: pins.dealVerdict[i], listPrice: pins.listPrice[i],
})) : [];

export const pinsGeoJson = (pins) => ({
  type: "FeatureCollection",
  features: pins.map((p) => ({
    type: "Feature",
    properties: { id: p.id, rank: p.rank, verdict: p.dealVerdict || "", address: p.address || "", price: Number.isFinite(p.listPrice) ? p.listPrice : null },
    geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
  })),
});

// The [west, south, east, north] box around the pins within the city limits, or the five boroughs
// when there are none. A pin geocoded outside the city still draws but does not widen the fit.
export function pinsBounds(pins) {
  const local = pins.filter((p) => Number.isFinite(p.longitude) && Number.isFinite(p.latitude) && inCity([p.longitude, p.latitude]));
  if (!local.length) return NYC;
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of local) {
    w = Math.min(w, p.longitude);
    e = Math.max(e, p.longitude);
    s = Math.min(s, p.latitude);
    n = Math.max(n, p.latitude);
  }
  return [[w, s], [e, n]];
}

// The listing layers in the theme's colors c, over the whole basemap: the mask first, so it dims the
// basemap's own labels outside the city, then the pins and clusters above it.
export function addListingLayers(map, c, data) {
  map.addSource("outside-city", { type: "geojson", data: outsideCity() });
  map.addLayer({ id: "outside-city", type: "fill", source: "outside-city", paint: { "fill-color": c.mask, "fill-opacity": 0.6 } });
  // Each cluster counts its great and good deals, so a crowd with a deal in it reads as one.
  const tierCount = (verdicts) => ["+", ["case", ["in", ["get", "verdict"], ["literal", verdicts]], 1, 0]];
  map.addSource("listings", {
    type: "geojson",
    data: data.listings,
    cluster: true,
    clusterRadius: 36,
    clusterMaxZoom: 13,
    clusterProperties: { deals: tierCount(["great_deal", "good_deal"]) },
  });
  map.addSource("listing-active", { type: "geojson", data: data.active });
  map.addSource("listing-selected", { type: "geojson", data: data.selected });
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "listings",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": c.ink,
      "circle-opacity": 0.92,
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 17, 50, 21, 200, 26],
      "circle-stroke-width": ["case", [">", ["get", "deals"], 0], 3, 2],
      "circle-stroke-color": ["case", [">", ["get", "deals"], 0], c.great, c.halo],
    },
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "listings",
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
    paint: { "text-color": c.onInk },
  });
  const tier = (great, good, fair, full, unpriced) => ["match", ["get", "verdict"], "great_deal", great, "good_deal", good, "fair_deal", fair, "full_price", full, unpriced];
  map.addLayer({
    id: "pins",
    type: "circle",
    source: "listings",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 14, 11],
      "circle-color": tier(c.great, c.goodFill, c.fair, c.hollow, c.unpriced),
      "circle-stroke-width": tier(1.5, 2, 1.5, 2, 1.5),
      "circle-stroke-color": tier(c.halo, c.good, c.halo, c.full, c.halo),
    },
  });
  for (const [id, source, color] of [["pin-active", "listing-active", c.ink], ["pin-selected", "listing-selected", c.ink]]) {
    map.addLayer({
      id,
      type: "circle",
      source,
      paint: {
        "circle-radius": id === "pin-selected" ? 15 : 13,
        "circle-color": tier(c.great, c.goodFill, c.fair, c.hollow, c.unpriced),
        "circle-stroke-width": 3,
        "circle-stroke-color": color,
      },
    });
  }
  // The card's number on each pin, over the marks, in the ink that reads on its tier's fill.
  map.addLayer({
    id: "pin-rank",
    type: "symbol",
    source: "listings",
    filter: ["!", ["has", "point_count"]],
    layout: { "text-field": ["to-string", ["get", "rank"]], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": tier(c.onInk, c.ink, c.onInk, c.ink, c.onInk) },
  });
}

const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
let maplibreReady = null;
function loadMaplibre() {
  if (!maplibreReady) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/maplibre/maplibre-gl.css";
    document.head.append(css);
    // A failed load is forgotten, so Try again on the map fetches it again.
    maplibreReady = import("/vendor/maplibre/maplibre-gl.mjs").catch((error) => { maplibreReady = null; throw error; });
  }
  return maplibreReady;
}

export async function createListingsMap(container, { onPick, onHover, onMove, describe }) {
  const maplibregl = await loadMaplibre();
  let mode = theme();
  let pins = [];
  let active = null;
  let selected = null;
  // A fit asked for while the map is hidden (phones show the list first) waits until it has a size;
  // the opening view is one, so a map first shown on a phone still opens on the five boroughs.
  let pendingFit = false;
  let pendingBounds = { ...NYC_EXTENT };
  let viewBounds = null;
  const map = new maplibregl.Map(mapOptions(container, mode));
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "listings-popup" });

  const marked = (id) => ({
    type: "FeatureCollection",
    features: id ? pinsGeoJson(pins.filter((p) => p.id === id)).features : [],
  });

  const addLayers = () => addListingLayers(map, PALETTE[mode], { listings: pinsGeoJson(pins), active: marked(active), selected: marked(selected) });

  map.on("style.load", addLayers);
  // The basemap style names sprite icons it does not ship (circle-11); a blank image keeps the
  // console clean (this MapLibre warns unless a resolver supplies it). The attribution starts
  // collapsed to its (i) button so it never covers the legend.
  map.setMissingStyleImageResolver((id) => { if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.once("load", () => container.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
  map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
  map.on("mousemove", "pins", (e) => {
    const f = e.features[0];
    map.getCanvas().style.cursor = "pointer";
    popup.setLngLat(f.geometry.coordinates).setText(describe(f.properties)).addTo(map);
    onHover(f.properties.id);
  });
  map.on("mouseleave", "pins", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
    onHover(null);
  });
  map.on("click", "pins", (e) => onPick(e.features[0].properties.id));
  map.on("click", "clusters", async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource("listings").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  // Every move the reader makes moves the list; the page's own moves (fitting new results, revealing
  // the open listing) carry the programmatic flag and do not.
  const PROGRAMMATIC = { programmatic: true };
  const LAYOUT = { programmatic: true, layoutResize: true };
  map.on("moveend", (e) => {
    if (!e.layoutResize) viewBounds = bounds();
    if (!e.programmatic) onMove(bounds());
  });

  // The page theme can change while the map is open; the pins keep their data across the new style.
  const observer = new MutationObserver(() => {
    if (theme() === mode) return;
    mode = theme();
    map.setStyle(STYLES[mode]);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  function bounds() {
    const b = map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }
  const setData = (source, data) => map.getSource(source)?.setData(data);
  function fitPins() {
    pendingBounds = null;
    pendingFit = !container.clientWidth || !container.clientHeight;
    if (!pendingFit) map.fitBounds(pinsBounds(pins), { padding: 40, maxZoom: 15, duration: 0 }, PROGRAMMATIC);
  }

  function setBounds(box) {
    viewBounds = box;
    pendingFit = false; pendingBounds = box;
    if (!container.clientWidth || !container.clientHeight) return;
    map.fitBounds([[box.west, box.south], [box.east, box.north]], {padding: 0, duration: 0}, LAYOUT);
    pendingBounds = null;
  }

  function resize() {
    if (!container.clientWidth || !container.clientHeight) return;
    map.resize(LAYOUT);
    if (pendingBounds) setBounds(pendingBounds);
    else if (pendingFit) fitPins();
    else if (viewBounds) setBounds(viewBounds);
  }
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(container);

  return {
    setPins(next, { fit = true } = {}) {
      pins = next;
      setData("listings", pinsGeoJson(pins));
      setData("listing-active", marked(active));
      setData("listing-selected", marked(selected));
      if (fit) fitPins();
    },
    setActive(id) {
      active = id;
      setData("listing-active", marked(id));
    },
    setSelected(id, { reveal = false } = {}) {
      selected = id;
      setData("listing-selected", marked(id));
      const pin = id && pins.find((p) => p.id === id);
      if (pin && reveal) {
        pendingBounds = null; pendingFit = false;
        if (!map.getBounds().contains([pin.longitude, pin.latitude])) map.easeTo({ center: [pin.longitude, pin.latitude] }, PROGRAMMATIC);
      }
    },
    bounds,
    setBounds,
    resize,
    destroy() {
      observer.disconnect();
      sizeObserver.disconnect();
      map.remove();
    },
  };
}
