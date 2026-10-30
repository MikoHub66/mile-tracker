// The MileTracker native plugin (plugins/mile-native), or a browser stand-in
// with the same API so the UI can be developed and smoke-tested on a desktop.

import { encodePolyline, newId, localParts, browserTz, haversineM, METERS_PER_MILE, round2 } from "./shared/trips.js";

const native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins.MileTracker : null;
export const isNative = Boolean(native);

function mockTracker() {
  const KEY = "mt.mock";
  const listeners = {};
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || { trips: [], enabled: false, config: {}, parked: null };
    } catch {
      return { trips: [], enabled: false, config: {}, parked: null };
    }
  };
  let s = load();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  };
  const emit = (ev, data) => (listeners[ev] || []).forEach((cb) => cb(data));
  const perms = { location: true, background: true, activity: true, notifications: true, bluetooth: true, batteryExempt: true };
  const status = () => ({
    enabled: s.enabled,
    driving: false,
    tripMiles: 0,
    highAccuracy: false,
    lastFixTs: Date.now(),
    pendingUploads: s.trips.filter((t) => !t.uploaded).length,
    cloud: false,
    uploadError: "",
    btConnected: false,
    btVehicle: "",
    permissions: perms,
    highAccuracyAlways: !!s.config.highAccuracyAlways,
    batterySaver: s.config.batterySaver !== false && !s.config.highAccuracyAlways,
    batterySaverSetting: s.config.batterySaver !== false,
  });
  return {
    mock: true,
    async getStatus() {
      return status();
    },
    async requestPermission() {
      return { granted: true };
    },
    async requestBatteryExemption() {},
    async openAppSettings() {},
    async start() {
      s.enabled = true;
      save();
    },
    async stop() {
      s.enabled = false;
      save();
    },
    async setConfig(c) {
      Object.assign(s.config, c);
      save();
    },
    async setCloud() {},
    async clearCloud() {},
    async listBluetoothDevices() {
      return { devices: [{ name: "Uconnect 4C", address: "00:11:22:33:44:55" }, { name: "Pixel Buds", address: "AA:BB:CC:DD:EE:FF" }] };
    },
    async getTrips() {
      return { trips: s.trips };
    },
    async updateTrip({ id, fields }) {
      const t = s.trips.find((x) => x.id === id);
      if (!t) throw new Error("Trip not found");
      Object.assign(t, fields);
      save();
      return t;
    },
    async deleteTrip({ id }) {
      s.trips = s.trips.filter((x) => x.id !== id);
      save();
      return { deleted: true };
    },
    async syncNow() {},
    async getParked() {
      return { parked: s.parked, driving: false };
    },
    async addListener(ev, cb) {
      (listeners[ev] ||= []).push(cb);
      return { remove() {} };
    },
    /** Browser only: fabricates a drive ending now, like the native service would. */
    simulateTrip() {
      const end = Date.now() - 6 * 60_000;
      const start = end - (15 + Math.random() * 25) * 60_000;
      const a = [41.88 + Math.random() * 0.05, -87.65 + Math.random() * 0.05];
      const pts = [a];
      for (let i = 0; i < 25; i++) {
        const p = pts[pts.length - 1];
        pts.push([p[0] + (Math.random() - 0.3) * 0.006, p[1] + (Math.random() - 0.3) * 0.008]);
      }
      let m = 0;
      for (let i = 1; i < pts.length; i++) m += haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      const tz = browserTz();
      const b = pts[pts.length - 1];
      const miles = round2(m / METERS_PER_MILE);
      const t = {
        id: newId(), source: "auto", vehicleId: s.config.vehicleId || "", vehicle: s.config.vehicleName || "",
        date: localParts(start, tz).date, tz, startTs: start, endTs: end,
        startLat: a[0], startLng: a[1], endLat: b[0], endLng: b[1],
        startAddress: "100 N State St, Chicago, IL 60602", endAddress: "233 S Wacker Dr, Chicago, IL 60606",
        gpsMiles: miles, miles, use: "unclassified", excluded: false, excludedReason: "", notes: "",
        path: encodePolyline(pts), uploaded: false, autoRule: "", btMatched: false, startPlace: "", endPlace: "",
      };
      s.trips.push(t);
      s.parked = { lat: b[0], lng: b[1], acc: 15, ts: end, source: "trip", vehicle: t.vehicle };
      save();
      emit("tripSaved", t);
      return t;
    },
  };
}

export const tracker = native || mockTracker();
