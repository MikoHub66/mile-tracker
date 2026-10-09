package com.miletracker.nativeplugins;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Address;
import android.location.Geocoder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-wide singleton shared by TripService (which feeds it locations) and
 * TripPlugin (the JS API). Owns the detector, the trip store and the uploader,
 * and persists the detector state so a trip in progress survives the service
 * being killed and restarted.
 */
public class TrackerHub {
    public interface Events {
        void onTripSaved(JSONObject trip);
        void onStatus(JSONObject status);
    }

    private static TrackerHub instance;

    public static synchronized TrackerHub get(Context ctx) {
        if (instance == null) instance = new TrackerHub(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    public final TripStore store;
    public final CloudUploader uploader;
    private final TripDetector detector = new TripDetector();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile Events events;
    private long lastFixTs;
    private TripDetector.Fix lastFix;
    private float lastAcc;
    private long lastSave;

    private TrackerHub(Context ctx) {
        this.ctx = ctx;
        store = new TripStore(ctx);
        uploader = new CloudUploader(ctx);
        restoreState();
    }

    public void setEvents(Events e) {
        events = e;
    }

    public SharedPreferences prefs() {
        return ctx.getSharedPreferences("mile_tracker", Context.MODE_PRIVATE);
    }

    public boolean trackingEnabled() {
        return prefs().getBoolean("enabled", false);
    }

    public boolean highAccuracyAlways() {
        return prefs().getBoolean("highAccuracyAlways", false);
    }

    // ---- fed by TripService (on its looper thread) ----

    public synchronized boolean wantsHighAccuracy() {
        return highAccuracyAlways() || detector.wantsHighAccuracy(System.currentTimeMillis());
    }

    public synchronized void onFix(TripDetector.Fix f) {
        lastFixTs = f.t;
        if (f.acc <= TripDetector.MAX_ACC_M) lastFix = f;
        lastAcc = f.acc;
        TripDetector.Trip t = detector.onFix(f);
        if (t != null) saveTrip(t);
        persistMaybe(t != null);
        emitStatus();
    }

    public synchronized void onTick(long now) {
        TripDetector.Trip t = detector.onTick(now);
        if (t != null) {
            saveTrip(t);
            persistMaybe(true);
            emitStatus();
        }
    }

    public synchronized void boost() {
        detector.boost(System.currentTimeMillis());
    }

    // ---- automation: car Bluetooth + classification rules ----

    /** JSON from setConfig({automation}): vehicles, places, workHours, requireBluetooth. */
    JSONObject automation() {
        try {
            return new JSONObject(prefs().getString("automation", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    JSONObject vehicleBy(String key, String value) {
        if (value == null || value.isEmpty()) return null;
        JSONArray vs = automation().optJSONArray("vehicles");
        if (vs == null) return null;
        for (int i = 0; i < vs.length(); i++) {
            JSONObject v = vs.optJSONObject(i);
            if (v != null && value.equalsIgnoreCase(v.optString(key))) return v;
        }
        return null;
    }

    /** Returns true when the device belongs to one of the user's vehicles. */
    public synchronized boolean onBluetooth(String address, boolean connected) {
        JSONObject v = vehicleBy("btAddress", address);
        if (v == null) return false;
        long now = System.currentTimeMillis();
        SharedPreferences.Editor e = prefs().edit();
        if (connected) {
            e.putString("btVehicleId", v.optString("id")).putString("btVehicleName", v.optString("name"))
                    .putLong("btConnectTs", now).putBoolean("btConnected", true);
            detector.boost(now);
        } else {
            e.putLong("btDisconnectTs", now).putBoolean("btConnected", false);
            // The car was switched off here: the best "where did I park" fix there is.
            if (lastFix != null && now - lastFix.t < 3 * 60_000L) {
                setParked(lastFix.lat, lastFix.lng, lastFix.acc, now, "bluetooth", v.optString("name"));
            }
        }
        e.apply();
        emitStatus();
        return true;
    }

    // ---- find my car ----

    void setParked(double lat, double lng, float acc, long ts, String source, String vehicle) {
        try {
            JSONObject p = new JSONObject().put("lat", lat).put("lng", lng).put("acc", acc)
                    .put("ts", ts).put("source", source).put("vehicle", vehicle == null ? "" : vehicle);
            prefs().edit().putString("parked", p.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** Where the car most likely is: {lat, lng, acc, ts, source: bluetooth|trip, vehicle} or null. */
    public JSONObject parked() {
        String s = prefs().getString("parked", "");
        if (s.isEmpty()) return null;
        try {
            return new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    /** Was a car's Bluetooth connected at some point during [startTs, endTs]? */
    private boolean btDuring(long startTs, long endTs) {
        SharedPreferences p = prefs();
        long on = p.getLong("btConnectTs", 0);
        if (on == 0 || on > endTs) return false;
        return p.getBoolean("btConnected", false) || p.getLong("btDisconnectTs", 0) >= startTs - 120_000;
    }

    Rules rules(String vehicleDefaultUse) {
        Rules r = new Rules();
        JSONObject a = automation();
        r.vehicleDefaultUse = vehicleDefaultUse;
        r.requireBluetooth = a.optBoolean("requireBluetooth", false);
        JSONArray places = a.optJSONArray("places");
        if (places != null) for (int i = 0; i < places.length(); i++) {
            JSONObject pl = places.optJSONObject(i);
            if (pl == null) continue;
            r.places.add(new Rules.Place(pl.optString("name"), pl.optDouble("lat"), pl.optDouble("lng"),
                    pl.optDouble("radius", 200), pl.optString("use", "")));
        }
        JSONObject w = a.optJSONObject("workHours");
        if (w != null && w.optBoolean("on")) {
            r.workHoursOn = true;
            r.workUse = w.optString("use", "");
            r.workStartMin = minutes(w.optString("start", "07:00"));
            r.workEndMin = minutes(w.optString("end", "17:00"));
            JSONArray days = w.optJSONArray("days");
            if (days != null) {
                r.workDays = new boolean[7];
                for (int i = 0; i < days.length(); i++) {
                    int d = days.optInt(i, -1);
                    if (d >= 0 && d < 7) r.workDays[d] = true;
                }
            }
        }
        return r;
    }

    private static int minutes(String hhmm) {
        try {
            String[] p = hhmm.split(":");
            return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
        } catch (Exception e) {
            return 0;
        }
    }

    public synchronized boolean isDriving() {
        return detector.isDriving();
    }

    public synchronized double currentMiles() {
        return detector.currentMeters() / Geo.METERS_PER_MILE;
    }

    public void uploadAsync() {
        io.execute(() -> {
            if (uploader.uploadPending(store) > 0) emitStatus();
        });
    }

    private void saveTrip(TripDetector.Trip t) {
        final JSONObject o = new JSONObject();
        try {
            TimeZone tz = TimeZone.getDefault();
            SimpleDateFormat day = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            day.setTimeZone(tz);
            double miles = Math.round(t.meters / Geo.METERS_PER_MILE * 100) / 100.0;
            SharedPreferences p = prefs();
            boolean bt = btDuring(t.startTs, t.endTs);
            String vehicleId = bt ? p.getString("btVehicleId", "") : p.getString("vehicleId", "");
            String vehicleName = bt ? p.getString("btVehicleName", "") : p.getString("vehicleName", "");
            JSONObject vehicle = vehicleBy("id", vehicleId);
            Rules.Result rule = rules(vehicle == null ? "" : vehicle.optString("defaultUse", "")).classify(t, bt, tz);
            o.put("id", UUID.randomUUID().toString());
            o.put("source", "auto");
            o.put("vehicleId", vehicleId);
            o.put("vehicle", vehicleName);
            o.put("btMatched", bt);
            o.put("autoRule", rule.rule);
            o.put("startPlace", rule.startPlace);
            o.put("endPlace", rule.endPlace);
            o.put("date", day.format(new Date(t.startTs)));
            o.put("tz", tz.getID());
            o.put("startTs", t.startTs);
            o.put("endTs", t.endTs);
            o.put("startLat", t.startLat);
            o.put("startLng", t.startLng);
            o.put("endLat", t.endLat);
            o.put("endLng", t.endLng);
            o.put("startAddress", "");
            o.put("endAddress", "");
            o.put("gpsMiles", miles);
            o.put("miles", miles);
            o.put("use", rule.use);
            o.put("excluded", rule.excluded);
            o.put("excludedReason", rule.excludedReason);
            o.put("notes", "");
            o.put("path", Geo.encodePolyline(t.path));
            o.put("uploaded", false);
        } catch (Exception e) {
            return;
        }
        store.add(o);
        // A Bluetooth-disconnect fix taken at this stop is more precise; keep it.
        JSONObject parked = parked();
        boolean btHere = parked != null && "bluetooth".equals(parked.optString("source"))
                && parked.optLong("ts") >= t.endTs - 60_000L;
        if (!btHere) setParked(t.endLat, t.endLng, 30, t.endTs, "trip", o.optString("vehicle"));
        io.execute(() -> {
            try {
                JSONObject addr = new JSONObject()
                        .put("startAddress", geocode(o.getDouble("startLat"), o.getDouble("startLng")))
                        .put("endAddress", geocode(o.getDouble("endLat"), o.getDouble("endLng")));
                JSONObject updated = store.update(o.getString("id"), addr);
                Events ev = events;
                if (ev != null && updated != null) ev.onTripSaved(updated);
            } catch (Exception ignored) {
            }
            uploader.uploadPending(store);
            emitStatus();
        });
    }

    /** Android's built-in geocoder (Google-backed on most phones). "" when unavailable. */
    @SuppressWarnings("deprecation")
    String geocode(double lat, double lng) {
        try {
            if (!Geocoder.isPresent()) return "";
            List<Address> list = new Geocoder(ctx, Locale.US).getFromLocation(lat, lng, 1);
            if (list == null || list.isEmpty()) return "";
            Address a = list.get(0);
            String line = a.getAddressLine(0);
            if (line == null) return "";
            return line.replaceAll(",\\s*(USA|United States)$", "");
        } catch (Exception e) {
            return "";
        }
    }

    public synchronized JSONObject status() {
        JSONObject s = new JSONObject();
        try {
            s.put("enabled", trackingEnabled());
            s.put("driving", detector.isDriving());
            s.put("tripMiles", Math.round(currentMiles() * 100) / 100.0);
            s.put("tripStartTs", detector.currentStartTs());
            s.put("highAccuracy", wantsHighAccuracy());
            s.put("lastFixTs", lastFixTs);
            s.put("lastAccuracy", lastAcc);
            s.put("pendingUploads", store.pendingCount());
            s.put("cloud", uploader.isConfigured());
            s.put("btConnected", prefs().getBoolean("btConnected", false));
            s.put("btVehicle", prefs().getString("btVehicleName", ""));
            s.put("uploadError", uploader.lastError);
            s.put("lastUploadTs", uploader.lastUploadTs);
        } catch (Exception ignored) {
        }
        return s;
    }

    private void emitStatus() {
        Events ev = events;
        if (ev != null) ev.onStatus(status());
    }

    // ---- detector persistence ----

    private void persistMaybe(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastSave < 30_000) return;
        lastSave = now;
        try {
            JSONObject o = new JSONObject();
            TripDetector d = detector;
            o.put("driving", d.driving);
            if (d.anchor != null) o.put("anchor", fix(d.anchor));
            o.put("anchorLastTs", d.anchorLastTs);
            o.put("startTs", d.startTs);
            o.put("startLat", d.startLat);
            o.put("startLng", d.startLng);
            JSONArray path = new JSONArray();
            for (double[] p : d.path) path.put(new JSONArray().put(p[0]).put(p[1]));
            o.put("path", path);
            o.put("meters", d.meters);
            o.put("maxSpeed", d.maxSpeed);
            if (d.lastGood != null) o.put("lastGood", fix(d.lastGood));
            if (d.dwellCenter != null) o.put("dwellCenter", fix(d.dwellCenter));
            o.put("dwellStartTs", d.dwellStartTs);
            o.put("dwellMeters", d.dwellMeters);
            o.put("dwellPathSize", d.dwellPathSize);
            prefs().edit().putString("detector", o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private void restoreState() {
        String s = prefs().getString("detector", "");
        if (s.isEmpty()) return;
        try {
            JSONObject o = new JSONObject(s);
            TripDetector d = detector;
            d.driving = o.optBoolean("driving");
            d.anchor = unfix(o.optJSONObject("anchor"));
            d.anchorLastTs = o.optLong("anchorLastTs");
            d.startTs = o.optLong("startTs");
            d.startLat = o.optDouble("startLat");
            d.startLng = o.optDouble("startLng");
            JSONArray path = o.optJSONArray("path");
            d.path = new ArrayList<>();
            if (path != null) for (int i = 0; i < path.length(); i++) {
                JSONArray p = path.getJSONArray(i);
                d.path.add(new double[]{p.getDouble(0), p.getDouble(1)});
            }
            d.meters = o.optDouble("meters", 0);
            d.maxSpeed = o.optDouble("maxSpeed", 0);
            d.lastGood = unfix(o.optJSONObject("lastGood"));
            d.dwellCenter = unfix(o.optJSONObject("dwellCenter"));
            d.dwellStartTs = o.optLong("dwellStartTs");
            d.dwellMeters = o.optDouble("dwellMeters", 0);
            d.dwellPathSize = o.optInt("dwellPathSize");
            if (d.driving && d.path.isEmpty()) d.driving = false;
        } catch (Exception ignored) {
        }
    }

    private static JSONObject fix(TripDetector.Fix f) throws Exception {
        return new JSONObject().put("lat", f.lat).put("lng", f.lng).put("acc", f.acc).put("speed", f.speed).put("t", f.t);
    }

    private static TripDetector.Fix unfix(JSONObject o) {
        if (o == null) return null;
        return new TripDetector.Fix(o.optDouble("lat"), o.optDouble("lng"), (float) o.optDouble("acc", 50),
                (float) o.optDouble("speed", -1), o.optLong("t"));
    }
}
