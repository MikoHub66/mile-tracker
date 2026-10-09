package com.miletracker.nativeplugins;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TimeZone;

public class TripDetectorTest {
    static final double LAT = 40.0, LNG = -75.0;
    static final double M_PER_DEG_LNG = 111320 * Math.cos(Math.toRadians(LAT));
    static final long T0 = 1_760_000_000_000L;

    /** Feeds fixes; returns trips produced (by fixes or ticks every 60 s). */
    static class Sim {
        final TripDetector d = new TripDetector();
        final List<TripDetector.Trip> trips = new ArrayList<>();
        long t = T0;
        long nextTick = T0 + 60_000;

        void fix(double eastM, float acc, float speed) {
            tickUntil(t);
            TripDetector.Trip tr = d.onFix(new TripDetector.Fix(LAT, LNG + eastM / M_PER_DEG_LNG, acc, speed, t));
            if (tr != null) trips.add(tr);
        }

        void tickUntil(long until) {
            while (nextTick <= until) {
                TripDetector.Trip tr = d.onTick(nextTick);
                if (tr != null) trips.add(tr);
                nextTick += 60_000;
            }
        }

        /** Parked at eastM for `ms`, a fix every `every` ms with a little jitter. */
        void park(double eastM, long ms, long every) {
            long end = t + ms;
            int i = 0;
            while (t < end) {
                fix(eastM + ((i++ % 3) - 1) * 8, 12, 0);
                t += every;
            }
        }

        /** Drives east from eastM at `mps` for `ms`. Returns the final position. */
        double drive(double eastM, double mps, long ms) {
            long end = t + ms;
            while (t < end) {
                t += 5_000;
                eastM += mps * 5;
                fix(eastM, 8, (float) mps);
            }
            return eastM;
        }
    }

    @Test
    public void detectsOneDriveBetweenTwoStops() {
        Sim s = new Sim();
        s.park(0, 10 * 60_000, 30_000);
        long lastParked = s.t - 30_000;
        double pos = s.drive(0, 15, 10 * 60_000);
        long arrived = s.t;
        s.park(pos, 7 * 60_000, 5_000);

        assertEquals(1, s.trips.size());
        TripDetector.Trip tr = s.trips.get(0);
        assertEquals(9000, tr.meters, 150);
        assertTrue("start " + (tr.startTs - lastParked), tr.startTs >= lastParked && tr.startTs <= lastParked + 30_000);
        assertEquals(LNG, tr.startLng, 0.0002);
        assertTrue("end " + (tr.endTs - T0) + " arrived " + (arrived - T0), Math.abs(arrived - tr.endTs) <= 10_000);
        assertEquals(LNG + pos / M_PER_DEG_LNG, tr.endLng, 0.0012); // within one 5 s fix (~75 m)
        assertFalse(s.d.isDriving());
    }

    @Test
    public void shortStopAtLightDoesNotSplitTrip() {
        Sim s = new Sim();
        s.park(0, 5 * 60_000, 30_000);
        double pos = s.drive(0, 15, 5 * 60_000);
        s.park(pos, 3 * 60_000, 5_000);          // red light / drive-thru: under 5 minutes
        pos = s.drive(pos, 15, 5 * 60_000);
        s.park(pos, 7 * 60_000, 5_000);
        assertEquals(1, s.trips.size());
        assertEquals(9000, s.trips.get(0).meters, 200);
    }

    @Test
    public void walkIsDiscarded() {
        Sim s = new Sim();
        s.park(0, 5 * 60_000, 30_000);
        double pos = s.drive(0, 1.4, 15 * 60_000); // ~1.3 km walk
        s.park(pos, 7 * 60_000, 5_000);
        assertTrue(s.trips.isEmpty());
    }

    @Test
    public void gpsLossInGarageEndsTripAfterGap() {
        Sim s = new Sim();
        s.park(0, 5 * 60_000, 30_000);
        s.drive(0, 15, 5 * 60_000);
        long lastFix = s.t;
        s.tickUntil(lastFix + TripDetector.GAP_END_MS + 60_000);
        assertEquals(1, s.trips.size());
        assertEquals(lastFix, s.trips.get(0).endTs);
    }

    @Test
    public void inaccurateFixesAreIgnoredButTriggerProbe() {
        Sim s = new Sim();
        s.park(0, 2 * 60_000, 30_000);
        assertFalse(s.d.wantsHighAccuracy(s.t));
        s.fix(1500, 300, -1); // coarse cell fix far away
        assertFalse(s.d.isDriving());
        assertTrue(s.d.wantsHighAccuracy(s.t));
    }

    @Test
    public void gpsJumpIsDropped() {
        Sim s = new Sim();
        s.park(0, 5 * 60_000, 30_000);
        double pos = s.drive(0, 15, 3 * 60_000);
        s.t += 5_000;
        s.fix(pos + 50_000, 10, 15); // 50 km in 5 s
        pos = s.drive(pos, 15, 2 * 60_000);
        s.park(pos, 7 * 60_000, 5_000);
        assertEquals(1, s.trips.size());
        assertEquals(4500, s.trips.get(0).meters, 200);
    }

    @Test
    public void polylineMatchesGoogleReference() {
        String enc = Geo.encodePolyline(Arrays.asList(
                new double[]{38.5, -120.2}, new double[]{40.7, -120.95}, new double[]{43.252, -126.453}));
        assertEquals("_p~iF~ps|U_ulLnnqC_mqNvxq`@", enc);
    }

    // ---- rules ----

    static TripDetector.Trip trip(double sLat, double sLng, double eLat, double eLng, long start, long durMs, double meters) {
        TripDetector.Trip t = new TripDetector.Trip();
        t.startLat = sLat;
        t.startLng = sLng;
        t.endLat = eLat;
        t.endLng = eLng;
        t.startTs = start;
        t.endTs = start + durMs;
        t.meters = meters;
        return t;
    }

    @Test
    public void rulesPreferBusinessPlaceOverHome() {
        Rules r = new Rules();
        r.places.add(new Rules.Place("Home", 40, -75, 200, "personal"));
        r.places.add(new Rules.Place("GPRS office", 40.1, -75, 200, "gprs"));
        Rules.Result res = r.classify(trip(40, -75, 40.1, -75, T0, 1_200_000, 12000), false, TimeZone.getTimeZone("America/New_York"));
        assertEquals("gprs", res.use);
        assertEquals("Home", res.startPlace);
        assertEquals("GPRS office", res.endPlace);
    }

    @Test
    public void rulesFlagPlanesAndMissingBluetooth() {
        Rules r = new Rules();
        TimeZone tz = TimeZone.getTimeZone("UTC");
        Rules.Result plane = r.classify(trip(40, -75, 42, -80, T0, 3_600_000, 500_000), true, tz);
        assertTrue(plane.excluded);
        assertEquals("plane", plane.excludedReason);

        r.requireBluetooth = true;
        Rules.Result uber = r.classify(trip(40, -75, 40.1, -75, T0, 1_200_000, 12000), false, tz);
        assertTrue(uber.excluded);
        Rules.Result car = r.classify(trip(40, -75, 40.1, -75, T0, 1_200_000, 12000), true, tz);
        assertFalse(car.excluded);
    }

    @Test
    public void rulesVehicleDefaultThenWorkHours() {
        TimeZone tz = TimeZone.getTimeZone("UTC");
        // T0 = 2025-10-09 08:53 UTC, a Thursday
        Rules r = new Rules();
        r.workHoursOn = true;
        r.workUse = "rustyrose";
        assertEquals("rustyrose", r.classify(trip(40, -75, 40.1, -75, T0, 600_000, 9000), true, tz).use);
        r.vehicleDefaultUse = "gprs";
        assertEquals("gprs", r.classify(trip(40, -75, 40.1, -75, T0, 600_000, 9000), true, tz).use);
        r.vehicleDefaultUse = "";
        r.workStartMin = 10 * 60;
        Rules.Result off = r.classify(trip(40, -75, 40.1, -75, T0, 600_000, 9000), true, tz);
        assertEquals("unclassified", off.use);
        assertNotNull(off.rule);
        assertNull(r.placeAt(0, 0));
    }
}
