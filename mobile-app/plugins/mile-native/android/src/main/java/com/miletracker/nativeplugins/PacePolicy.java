package com.miletracker.nativeplugins;

/**
 * Pure (no Android APIs, unit tested) choice of how often to take GPS fixes while driving.
 *
 * The GPS radio is the heat and battery cost, so the fix rate matters, not how many points are
 * stored. Mileage is the sum of straight chords between fixes, so sparse fixes only lose distance
 * on curves. That makes it safe to stretch the interval on fast, straight roads and keep it short
 * where the road bends:
 *
 *   CITY   (default, turns, slow traffic)                 -> fix every 8 s
 *   CRUISE (two fixes in a row >= 45 mph, heading within 20 deg) -> fix every 20 s
 *
 * Cruise ends as soon as a fix is under 35 mph or the heading swings more than 30 deg (exit ramp,
 * curve, turn). The gap between the two speed thresholds stops it flapping between modes.
 */
public class PacePolicy {
    public static final double CRUISE_ENTER_MS = 20.1;   // 45 mph
    public static final double CRUISE_EXIT_MS = 15.6;    // 35 mph
    public static final double STRAIGHT_DEG = 20;
    public static final double TURN_DEG = 30;
    public static final long CITY_INTERVAL_MS = 8_000;
    public static final long CRUISE_INTERVAL_MS = 20_000;
    /** While driving, fixes may be delivered in batches up to this late so the CPU can sleep. */
    public static final long DRIVE_BATCH_MS = 60_000;

    private boolean cruising;
    private int fastStraight;     // consecutive fast fixes with a steady heading
    private double lastBearing = Double.NaN;

    public boolean isCruising() {
        return cruising;
    }

    public long intervalMs() {
        return cruising ? CRUISE_INTERVAL_MS : CITY_INTERVAL_MS;
    }

    public void reset() {
        cruising = false;
        fastStraight = 0;
        lastBearing = Double.NaN;
    }

    /** speed m/s (negative = unknown); bearing degrees or NaN if unknown. */
    public void onFix(double speed, double bearing) {
        double turn = Double.isNaN(bearing) || Double.isNaN(lastBearing) ? Double.NaN : angleDiff(bearing, lastBearing);
        if (!Double.isNaN(bearing)) lastBearing = bearing;

        if (cruising) {
            boolean slow = speed >= 0 && speed < CRUISE_EXIT_MS;
            boolean turning = !Double.isNaN(turn) && turn > TURN_DEG;
            if (slow || turning || speed < 0) {
                cruising = false;
                fastStraight = 0;
            }
            return;
        }
        boolean steady = Double.isNaN(turn) || turn <= STRAIGHT_DEG;
        if (speed >= CRUISE_ENTER_MS && steady) fastStraight++;
        else fastStraight = 0;
        if (fastStraight >= 2) cruising = true;
    }

    static double angleDiff(double a, double b) {
        double d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    }
}
