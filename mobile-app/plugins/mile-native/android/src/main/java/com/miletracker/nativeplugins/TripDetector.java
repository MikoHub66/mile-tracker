package com.miletracker.nativeplugins;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure trip-detection state machine (no Android APIs, unit tested).
 *
 * IDLE:    we know where the phone is parked (the anchor). A good fix more than
 *          START_DIST_M from the anchor, or a fast one more than 100 m away,
 *          starts a trip whose start point is the anchor and whose start time is
 *          the last time the phone was seen there.
 * DRIVING: fixes are added to the path. When fixes stay within STOP_RADIUS_M of
 *          one spot for DWELL_MS (5 minutes), the trip ends at that spot, at the
 *          time the phone first arrived there. Losing GPS for GAP_END_MS also ends
 *          the trip at the last place it was seen (parking garages, phone died).
 *
 * Trips shorter than MIN_TRIP_M or that never went faster than MIN_MAX_SPEED
 * (walks) are discarded.
 */
public class TripDetector {

    public static final float MAX_ACC_M = 65f;          // ignore fixes worse than this
    public static final float PROBE_ACC_M = 500f;       // coarse fixes can still trigger a GPS probe
    public static final double START_DIST_M = 250;
    public static final double START_SPEED_MS = 6.7;    // 15 mph
    public static final double STOP_RADIUS_M = 150;
    public static final long DWELL_MS = 5 * 60_000L;
    public static final long GAP_END_MS = 10 * 60_000L;
    public static final double MIN_TRIP_M = 500;
    public static final double MIN_MAX_SPEED_MS = 6.0;  // ~13 mph: anything slower was a walk
    public static final double MAX_PLAUSIBLE_MS = 90;   // GPS jumps faster than ~200 mph are dropped
    public static final double PATH_SPACING_M = 20;
    public static final long PROBE_MS = 3 * 60_000L;

    public static class Fix {
        public final double lat, lng;
        public final float acc;
        public final float speed; // m/s, negative = unknown
        public final long t;

        public Fix(double lat, double lng, float acc, float speed, long t) {
            this.lat = lat;
            this.lng = lng;
            this.acc = acc;
            this.speed = speed;
            this.t = t;
        }
    }

    public static class Trip {
        public long startTs, endTs;
        public double startLat, startLng, endLat, endLng;
        public double meters;
        public double maxSpeed;
        public List<double[]> path = new ArrayList<>();
    }

    // ---- state (package-private so TrackerState can persist it) ----
    boolean driving;
    // IDLE
    Fix anchor;
    long anchorLastTs;
    long probeUntil;
    // DRIVING
    long startTs;
    double startLat, startLng;
    List<double[]> path = new ArrayList<>();
    double meters;
    double maxSpeed;
    Fix lastGood;
    Fix dwellCenter;
    long dwellStartTs;
    double dwellMeters;
    int dwellPathSize;

    public boolean isDriving() {
        return driving;
    }

    public double currentMeters() {
        return driving ? meters : 0;
    }

    public long currentStartTs() {
        return driving ? startTs : 0;
    }

    public boolean wantsHighAccuracy(long now) {
        return driving || now < probeUntil || anchor == null;
    }

    /** Activity recognition saw the phone get into a vehicle. */
    public void boost(long now) {
        probeUntil = Math.max(probeUntil, now + PROBE_MS);
    }

    /** Feeds one location. Returns a finished trip when this fix completed one. */
    public Trip onFix(Fix f) {
        if (driving) {
            Trip done = null;
            if (lastGood != null && f.t - lastGood.t >= GAP_END_MS && f.acc <= MAX_ACC_M) {
                done = finish();
                idleFix(f);
                return done;
            }
            drivingFix(f);
            if (dwellCenter != null && f.t - dwellStartTs >= DWELL_MS) return finish();
            return null;
        }
        idleFix(f);
        return null;
    }

    /** Called about once a minute so a trip can end even if fixes stop arriving. */
    public Trip onTick(long now) {
        if (!driving || lastGood == null) return null;
        boolean seenStopped = lastGood.t - dwellStartTs >= 60_000L;
        if (seenStopped && now - dwellStartTs >= DWELL_MS) return finish();
        if (now - lastGood.t >= GAP_END_MS) return finish();
        return null;
    }

    private void idleFix(Fix f) {
        if (f.acc > MAX_ACC_M) {
            // Coarse (Wi-Fi / cell) fix: if it is clearly somewhere else, turn on GPS to check.
            if (f.acc <= PROBE_ACC_M && anchor != null
                    && Geo.distance(anchor.lat, anchor.lng, f.lat, f.lng) - f.acc > START_DIST_M) {
                probeUntil = Math.max(probeUntil, f.t + PROBE_MS);
            }
            return;
        }
        if (anchor == null) {
            anchor = f;
            anchorLastTs = f.t;
            if (f.speed >= START_SPEED_MS) startTrip(f);
            return;
        }
        double d = Geo.distance(anchor.lat, anchor.lng, f.lat, f.lng);
        if (d > START_DIST_M || (f.speed >= START_SPEED_MS && d > 100)) {
            startTrip(f);
            return;
        }
        // Only a stationary fix says "still parked here"; a moving one near the
        // anchor is the start of a departure and must not drag the anchor along.
        boolean stationary = f.speed >= 0 ? f.speed < 2 : d < 50;
        if (d <= STOP_RADIUS_M && stationary) {
            anchorLastTs = f.t;
            if (f.acc < anchor.acc && d < 50) anchor = new Fix(f.lat, f.lng, f.acc, 0, anchor.t);
        }
    }

    private void startTrip(Fix f) {
        driving = true;
        probeUntil = 0;
        double d = Geo.distance(anchor.lat, anchor.lng, f.lat, f.lng);
        // Left the anchor some time after it was last seen there; if the phone was
        // asleep for a long while, assume ~15 m/s to the first moving fix.
        long est = f.t - (long) (d / 15.0 * 1000);
        startTs = Math.min(f.t, Math.max(anchorLastTs, est));
        startLat = anchor.lat;
        startLng = anchor.lng;
        path = new ArrayList<>();
        path.add(new double[]{anchor.lat, anchor.lng});
        meters = 0;
        maxSpeed = Math.max(0, f.speed);
        lastGood = null;
        dwellCenter = null;
        drivingFix(f);
    }

    private void drivingFix(Fix f) {
        if (f.acc > MAX_ACC_M) return;
        double[] last = path.get(path.size() - 1);
        double seg = Geo.distance(last[0], last[1], f.lat, f.lng);
        if (lastGood != null) {
            double dt = (f.t - lastGood.t) / 1000.0;
            double fromLast = Geo.distance(lastGood.lat, lastGood.lng, f.lat, f.lng);
            if (dt > 0 && fromLast / dt > MAX_PLAUSIBLE_MS) return; // GPS jump
            if (f.speed >= 0) maxSpeed = Math.max(maxSpeed, f.speed);
            else if (dt >= 3 && fromLast > 30) maxSpeed = Math.max(maxSpeed, fromLast / dt);
        } else if (f.speed >= 0) {
            maxSpeed = Math.max(maxSpeed, f.speed);
        }
        lastGood = f;
        if (seg >= PATH_SPACING_M) {
            path.add(new double[]{f.lat, f.lng});
            meters += seg;
        }
        if (dwellCenter == null || Geo.distance(dwellCenter.lat, dwellCenter.lng, f.lat, f.lng) > STOP_RADIUS_M) {
            dwellCenter = f;
            dwellStartTs = f.t;
            dwellMeters = meters;
            dwellPathSize = path.size();
        }
    }

    private Trip finish() {
        Trip t = new Trip();
        t.startTs = startTs;
        t.startLat = startLat;
        t.startLng = startLng;
        // Stopped (seen in one spot for a minute+): end where the stop began.
        // Otherwise the signal was lost while moving: end at the last fix.
        boolean stopped = dwellCenter != null && lastGood != null && lastGood.t - dwellStartTs >= 60_000L;
        Fix end = stopped ? dwellCenter : lastGood;
        t.endTs = stopped ? dwellStartTs : (lastGood != null ? lastGood.t : startTs);
        if (end != null) {
            t.endLat = end.lat;
            t.endLng = end.lng;
        } else {
            t.endLat = startLat;
            t.endLng = startLng;
        }
        t.meters = stopped ? dwellMeters : meters;
        int keep = stopped ? dwellPathSize : path.size();
        t.path = new ArrayList<>(path.subList(0, Math.min(keep, path.size())));
        double[] tail = t.path.get(t.path.size() - 1);
        if (tail[0] != t.endLat || tail[1] != t.endLng) t.path.add(new double[]{t.endLat, t.endLng});
        t.maxSpeed = maxSpeed;

        driving = false;
        anchor = end != null ? new Fix(end.lat, end.lng, end.acc, 0, end.t) : anchor;
        anchorLastTs = lastGood != null ? lastGood.t : t.endTs;
        path = new ArrayList<>();
        meters = 0;
        lastGood = null;
        dwellCenter = null;

        if (t.meters < MIN_TRIP_M || t.maxSpeed < MIN_MAX_SPEED_MS) return null;
        return t;
    }
}
