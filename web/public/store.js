// Web map data layer. Cloud mode = Firestore users/{uid}/...; demo mode =
// localStorage with generated sample trips (used when Firebase isn't set up
// yet, or with ?demo in the URL).

import { firebaseConfig } from "./shared/firebase-config.js";
import { normalizeTrip, newId, encodePolyline, haversineM, METERS_PER_MILE, round2, zonedToEpoch, browserTz } from "./shared/trips.js";

const V = "10.13.0";
export const configured = Boolean(firebaseConfig.apiKey) && firebaseConfig.apiKey !== "PASTE_ME";
export const demo = !configured || new URLSearchParams(location.search).has("demo");

let fbApp, fbAuth, fbStore, auth, db;
if (!demo) {
  [fbApp, fbAuth, fbStore] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = fbApp.initializeApp(firebaseConfig);
  auth = fbAuth.getAuth(app);
  db = fbStore.getFirestore(app);
}

// ---------------- demo data ----------------

const DEMO_KEY = "mt.web.demo";
function demoData() {
  try {
    const d = JSON.parse(localStorage.getItem(DEMO_KEY));
    if (d) return d;
  } catch {}
  const tz = browserTz();
  const vehicles = [
    { id: "v1", name: "2021 F-150", make: "Ford", model: "F-150", year: "2021", plate: "", defaultUse: "" },
    { id: "v2", name: "2019 RAV4", make: "Toyota", model: "RAV4", year: "2019", plate: "", defaultUse: "" },
  ];
  const places = [
    ["1200 W Main St, Springfield, IL 62702", 39.8017, -89.6650],
    ["GPRS Office, 300 S 6th St, Springfield, IL 62701", 39.7990, -89.6480],
    ["RustyRose Studio, 2501 Wabash Ave, Springfield, IL 62704", 39.7794, -89.6838],
    ["Walmart, 3401 Freedom Dr, Springfield, IL 62704", 39.7736, -89.7036],
    ["Client site, 2200 Stevenson Dr, Springfield, IL 62703", 39.7616, -89.6278],
    ["Abraham Lincoln Capital Airport, Springfield, IL 62707", 39.8441, -89.6779],
  ];
  const trips = [];
  const today = new Date();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let back = 75; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    if (d.getDay() === 0 && rnd() < 0.6) continue;
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let hour = 7.5 + rnd();
    let at = 0;
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      let to = Math.floor(rnd() * places.length);
      if (to === at) to = (to + 1) % places.length;
      if (i === n - 1) to = 0;
      const a = places[at], b = places[to];
      const pts = [[a[1], a[2]]];
      const steps = 12;
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const jog = k < steps / 2 ? [b[1], a[2]] : [b[1], b[2]];
        pts.push([a[1] + (jog[0] - a[1]) * Math.min(1, f * 2) + (rnd() - 0.5) * 0.001, a[2] + (b[2] - a[2]) * Math.max(0, f * 2 - 1) + (rnd() - 0.5) * 0.001]);
      }
      pts.push([b[1], b[2]]);
      let m = 0;
      for (let k = 1; k < pts.length; k++) m += haversineM(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
      const mins = Math.max(6, (m / 12) / 60);
      const hh = Math.floor(hour), mm = Math.floor((hour % 1) * 60);
      const startTs = zonedToEpoch(date, `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, tz);
      const miles = round2(m / METERS_PER_MILE);
      const biz = to === 1 || at === 1 || to === 4 ? "gprs" : to === 2 || at === 2 ? "rustyrose" : "personal";
      const old = back > 3;
      trips.push(normalizeTrip({
        id: newId(), source: "auto", vehicleId: rnd() < 0.8 ? "v1" : "v2", date, tz, startTs, endTs: startTs + mins * 60000,
        startLat: a[1], startLng: a[2], endLat: b[1], endLng: b[2], startAddress: a[0], endAddress: b[0],
        gpsMiles: miles, miles, use: old ? biz : "unclassified", path: encodePolyline(pts),
        excluded: to === 5 && rnd() < 0.5, excludedReason: to === 5 ? "plane" : "", autoRule: old && rnd() < 0.4 ? "learned from your past trips" : "",
      }));
      hour += mins / 60 + 1 + rnd() * 3;
      at = to;
    }
  }
  for (const t of trips) t.vehicle = vehicles.find((v) => v.id === t.vehicleId).name;
  const data = { trips, vehicles, automation: { defaultVehicleId: "v1" } };
  saveDemo(data);
  return data;
}
function saveDemo(d) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(d));
  } catch {}
}

// ---------------- API ----------------

const listeners = new Set();
let demoState = demo ? demoData() : null;
const fireDemo = () => {
  saveDemo(demoState);
  listeners.forEach((f) => f());
};

export const api = {
  user: null,

  onAuth(cb) {
    if (demo) return cb({ email: "demo", uid: "demo" });
    fbAuth.onAuthStateChanged(auth, (u) => {
      this.user = u;
      cb(u);
    });
  },
  signIn: (email, pw) => fbAuth.signInWithEmailAndPassword(auth, email, pw),
  signUp: (email, pw) => fbAuth.createUserWithEmailAndPassword(auth, email, pw),
  resetPassword: (email) => fbAuth.sendPasswordResetEmail(auth, email),
  signOut: () => (demo ? null : fbAuth.signOut(auth)),
  resetDemo() {
    localStorage.removeItem(DEMO_KEY);
    demoState = demoData();
    fireDemo();
  },

  col(name) {
    return fbStore.collection(db, "users", this.user.uid, name);
  },

  /** Live trips with from <= date <= to (YYYY-MM-DD). Returns an unsubscribe function. */
  watchTrips(from, to, cb) {
    if (demo) {
      const run = () => cb(demoState.trips.filter((t) => t.date >= from && t.date <= to).map(normalizeTrip));
      listeners.add(run);
      run();
      return () => listeners.delete(run);
    }
    const q = fbStore.query(this.col("trips"), fbStore.where("date", ">=", from), fbStore.where("date", "<=", to));
    return fbStore.onSnapshot(q, (snap) => cb(snap.docs.map((d) => normalizeTrip({ ...d.data(), id: d.id }))));
  },

  async getTrips(from, to) {
    if (demo) return demoState.trips.filter((t) => t.date >= from && t.date <= to).map(normalizeTrip);
    const q = fbStore.query(this.col("trips"), fbStore.where("date", ">=", from), fbStore.where("date", "<=", to));
    const snap = await fbStore.getDocs(q);
    return snap.docs.map((d) => normalizeTrip({ ...d.data(), id: d.id }));
  },

  async updateTrip(id, fields) {
    if (demo) {
      Object.assign(demoState.trips.find((t) => t.id === id), fields);
      return fireDemo();
    }
    await fbStore.updateDoc(fbStore.doc(this.col("trips"), id), { ...fields, updatedAt: Date.now() });
  },

  async createTrip(trip) {
    const id = trip.id || newId();
    const data = normalizeTrip({ ...trip, id, createdAt: Date.now(), updatedAt: Date.now() });
    if (demo) {
      demoState.trips.push(data);
      return fireDemo();
    }
    delete data.id;
    await fbStore.setDoc(fbStore.doc(this.col("trips"), id), data);
  },

  async deleteTrip(id) {
    if (demo) {
      demoState.trips = demoState.trips.filter((t) => t.id !== id);
      return fireDemo();
    }
    await fbStore.deleteDoc(fbStore.doc(this.col("trips"), id));
  },

  watchVehicles(cb) {
    if (demo) {
      const run = () => cb([...demoState.vehicles]);
      listeners.add(run);
      run();
      return () => listeners.delete(run);
    }
    return fbStore.onSnapshot(this.col("vehicles"), (snap) =>
      cb(snap.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => (a.name || "").localeCompare(b.name || ""))),
    );
  },

  watchAutomation(cb) {
    if (demo) {
      const run = () => cb(demoState.automation || {});
      listeners.add(run);
      run();
      return () => listeners.delete(run);
    }
    return fbStore.onSnapshot(fbStore.doc(db, "users", this.user.uid, "settings", "automation"), (s) => cb(s.data() || {}));
  },

  async saveVehicle(v) {
    const id = v.id || newId();
    const data = { name: "", make: "", model: "", year: "", plate: "", defaultUse: "", ...v, id };
    if (demo) {
      demoState.vehicles = [...demoState.vehicles.filter((x) => x.id !== id), data].sort((a, b) => a.name.localeCompare(b.name));
      fireDemo();
      return data;
    }
    const { id: _, ...rest } = data;
    await fbStore.setDoc(fbStore.doc(this.col("vehicles"), id), rest, { merge: true });
    return data;
  },

  async deleteVehicle(id) {
    if (demo) {
      demoState.vehicles = demoState.vehicles.filter((x) => x.id !== id);
      return fireDemo();
    }
    await fbStore.deleteDoc(fbStore.doc(this.col("vehicles"), id));
  },
};

// ---------------- free geocoding + routing (manual trips) ----------------

/** OpenStreetMap Nominatim search. Returns {lat, lng, label} or null. */
export async function geocode(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`, {
    headers: { Accept: "application/json" },
  });
  const j = await r.json();
  if (!j.length) return null;
  return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
}

/** Driving distance via the public OSRM router. Returns {miles, path: [[lat,lng],...]} or null. */
export async function route(a, b) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`);
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.length) return null;
  const rt = j.routes[0];
  return { miles: round2(rt.distance / METERS_PER_MILE), minutes: rt.duration / 60, path: rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]) };
}
