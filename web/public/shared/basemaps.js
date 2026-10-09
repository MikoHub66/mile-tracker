// Basemaps shared by the web map and the phone app (identical copies; see
// sync-shared). Needs Leaflet's global `L`. The chosen basemap is remembered
// per device in localStorage.

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_ATTR = "Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, and the GIS User Community";

export const BASEMAPS = {
  streets: {
    label: "Streets",
    layers: () => [
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }),
    ],
  },
  satellite: {
    label: "Satellite",
    layers: () => [
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_ATTR }),
    ],
  },
  hybrid: {
    label: "Satellite + labels",
    layers: () => [
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_ATTR }),
      L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 19 }),
      L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 19 }),
    ],
  },
};

const KEY = "mt.basemap";

export function savedBasemap() {
  try {
    const v = localStorage.getItem(KEY);
    return BASEMAPS[v] ? v : "streets";
  } catch {
    return "streets";
  }
}

/**
 * Adds the remembered basemap plus a layer switcher (top right) to `map`.
 * Returns the switcher control.
 */
export function addBasemaps(map, { position = "topright" } = {}) {
  const groups = {};
  for (const [id, b] of Object.entries(BASEMAPS)) groups[b.label] = L.layerGroup(b.layers());
  const current = savedBasemap();
  groups[BASEMAPS[current].label].addTo(map);
  map.on("baselayerchange", (e) => {
    const id = Object.keys(BASEMAPS).find((k) => BASEMAPS[k].label === e.name);
    try {
      if (id) localStorage.setItem(KEY, id);
    } catch {}
  });
  return L.control.layers(groups, null, { position, collapsed: true }).addTo(map);
}
