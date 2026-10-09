// One data interface for the UI in both modes:
//   cloud  signed in: trips/vehicles/settings in Firestore users/{uid}/..., plus
//          trips still waiting on the phone to upload (native store, uploaded=false)
//   local  no Firebase / signed out: native store + localStorage
// Automation settings are always pushed to the native plugin, which applies
// them to new trips (Bluetooth vehicle, places, work hours, ...).

import { configured, auth, db, fb, firebaseConfig } from "./firebase.js";
import { tracker } from "./native.js";
import { normalizeTrip, learnUse, newId } from "./shared/trips.js";

const LS = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

export const DEFAULT_AUTOMATION = {
  defaultVehicleId: "",
  requireBluetooth: false,
  learn: true,
  places: [],
  workHours: { on: false, days: [1, 2, 3, 4, 5], start: "07:00", end: "17:00", use: "" },
};

const HISTORY_DAYS = 120;

export const store = {
  mode: "local",
  user: null,
  cloudTrips: [],
  localTrips: [],
  vehicles: LS.get("mt.vehicles", []),
  automation: { ...DEFAULT_AUTOMATION, ...LS.get("mt.automation", {}) },
  listeners: new Set(),
  unsub: [],

  get trips() {
    if (this.mode !== "cloud") return this.localTrips.map(normalizeTrip);
    const ids = new Set(this.cloudTrips.map((t) => t.id));
    const pending = this.localTrips.filter((t) => !t.uploaded && !ids.has(t.id)).map((t) => ({ ...normalizeTrip(t), pending: true }));
    return [...this.cloudTrips, ...pending];
  },

  onChange(cb) {
    this.listeners.add(cb);
  },
  emit() {
    this.listeners.forEach((cb) => cb());
  },

  async init() {
    await this.refreshLocal();
    tracker.addListener("tripSaved", () => this.refreshLocal());
    if (configured) {
      fb.onAuthStateChanged(auth, (u) => this.setUser(u));
      // Keep the native uploader's refresh token current.
      fb.onIdTokenChanged(auth, (u) => u && this.pushCloud(u));
    } else {
      await this.pushAutomation();
    }
  },

  async refreshLocal() {
    try {
      this.localTrips = (await tracker.getTrips()).trips || [];
    } catch {
      this.localTrips = [];
    }
    this.emit();
  },

  pushCloud(u) {
    return tracker.setCloud({ apiKey: firebaseConfig.apiKey, projectId: firebaseConfig.projectId, uid: u.uid, refreshToken: u.refreshToken });
  },

  setUser(u) {
    this.unsub.forEach((f) => f());
    this.unsub = [];
    this.user = u;
    this.mode = u ? "cloud" : "local";
    if (!u) {
      this.cloudTrips = [];
      this.vehicles = LS.get("mt.vehicles", []);
      this.automation = { ...DEFAULT_AUTOMATION, ...LS.get("mt.automation", {}) };
      tracker.clearCloud();
      this.pushAutomation();
      this.emit();
      return;
    }
    this.pushCloud(u);
    const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
    const base = ["users", u.uid];
    this.unsub.push(
      fb.onSnapshot(fb.query(fb.collection(db, ...base, "trips"), fb.where("date", ">=", since)), (snap) => {
        this.cloudTrips = snap.docs.map((d) => normalizeTrip({ ...d.data(), id: d.id }));
        this.emit();
        this.autoLearn();
      }),
      fb.onSnapshot(fb.collection(db, ...base, "vehicles"), (snap) => {
        this.vehicles = snap.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        this.pushAutomation();
        this.emit();
      }),
      fb.onSnapshot(fb.doc(db, ...base, "settings", "automation"), (snap) => {
        this.automation = { ...DEFAULT_AUTOMATION, ...(snap.data() || {}) };
        this.pushAutomation();
        this.emit();
      }),
    );
  },

  /** Classifies unreviewed trips that match a route the user always classifies the same way. */
  async autoLearn() {
    if (!this.automation.learn) return;
    const all = this.trips;
    for (const t of all) {
      if (t.use !== "unclassified" || t.excluded || t.useLocked) continue;
      const use = learnUse(t, all);
      if (use) await this.updateTrip(t, { use, autoRule: "learned from your past trips" });
    }
  },

  async updateTrip(trip, fields) {
    if (this.mode === "cloud" && !trip.pending) {
      await fb.updateDoc(fb.doc(db, "users", this.user.uid, "trips", trip.id), { ...fields, updatedAt: Date.now() });
    } else {
      await tracker.updateTrip({ id: trip.id, fields });
      await this.refreshLocal();
    }
  },

  async deleteTrip(trip) {
    if (this.mode === "cloud" && !trip.pending) await fb.deleteDoc(fb.doc(db, "users", this.user.uid, "trips", trip.id));
    else {
      await tracker.deleteTrip({ id: trip.id });
      await this.refreshLocal();
    }
  },

  // ---- vehicles & automation ----

  defaultVehicle() {
    return this.vehicles.find((v) => v.id === this.automation.defaultVehicleId) || this.vehicles[0] || null;
  },

  async saveVehicle(v) {
    const vehicle = { name: "", make: "", model: "", year: "", plate: "", btAddress: "", btName: "", defaultUse: "", ...v, id: v.id || newId() };
    if (this.mode === "cloud") {
      const { id, ...data } = vehicle;
      await fb.setDoc(fb.doc(db, "users", this.user.uid, "vehicles", id), data);
    } else {
      const list = this.vehicles.filter((x) => x.id !== vehicle.id);
      list.push(vehicle);
      this.vehicles = list.sort((a, b) => a.name.localeCompare(b.name));
      LS.set("mt.vehicles", this.vehicles);
      await this.pushAutomation();
      this.emit();
    }
    if (!this.automation.defaultVehicleId) await this.saveAutomation({ defaultVehicleId: vehicle.id });
    return vehicle;
  },

  async deleteVehicle(id) {
    if (this.mode === "cloud") await fb.deleteDoc(fb.doc(db, "users", this.user.uid, "vehicles", id));
    else {
      this.vehicles = this.vehicles.filter((x) => x.id !== id);
      LS.set("mt.vehicles", this.vehicles);
      await this.pushAutomation();
      this.emit();
    }
  },

  async saveAutomation(patch) {
    this.automation = { ...this.automation, ...patch };
    if (this.mode === "cloud") await fb.setDoc(fb.doc(db, "users", this.user.uid, "settings", "automation"), this.automation);
    else LS.set("mt.automation", this.automation);
    await this.pushAutomation();
    this.emit();
  },

  /** Sends vehicles + rules to the native service, which classifies new trips with them. */
  async pushAutomation() {
    const v = this.defaultVehicle();
    const a = this.automation;
    await tracker.setConfig({
      vehicleId: v?.id || "",
      vehicleName: v?.name || "",
      automation: {
        vehicles: this.vehicles.map(({ id, name, btAddress, defaultUse }) => ({ id, name, btAddress: btAddress || "", defaultUse: defaultUse || "" })),
        places: a.places,
        workHours: a.workHours,
        requireBluetooth: a.requireBluetooth && this.vehicles.some((x) => x.btAddress),
      },
    });
  },

  // ---- account ----
  signIn: (email, pw) => fb.signInWithEmailAndPassword(auth, email, pw),
  signUp: (email, pw) => fb.createUserWithEmailAndPassword(auth, email, pw),
  resetPassword: (email) => fb.sendPasswordResetEmail(auth, email),
  signOut: () => fb.signOut(auth),
};
