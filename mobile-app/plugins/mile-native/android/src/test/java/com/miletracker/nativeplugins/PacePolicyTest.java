package com.miletracker.nativeplugins;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PacePolicyTest {
    private static final double MPH = 0.44704;

    @Test
    public void townDrivingStaysAtEightSeconds() {
        PacePolicy p = new PacePolicy();
        for (int i = 0; i < 20; i++) p.onFix(30 * MPH, 90 + (i % 2) * 5);
        assertFalse(p.isCruising());
        assertEquals(8_000, p.intervalMs());
    }

    @Test
    public void fastStraightRoadCruisesAfterTwoFixes() {
        PacePolicy p = new PacePolicy();
        p.onFix(60 * MPH, 10);
        assertFalse(p.isCruising());
        p.onFix(62 * MPH, 14);
        assertTrue(p.isCruising());
        assertEquals(20_000, p.intervalMs());
        p.onFix(40 * MPH, 16); // between 35 and 45 mph: stays cruising (no flapping)
        assertTrue(p.isCruising());
    }

    @Test
    public void turnOrSlowdownEndsCruise() {
        PacePolicy p = new PacePolicy();
        p.onFix(65 * MPH, 350);
        p.onFix(65 * MPH, 5); // 15 deg across north: still straight
        assertTrue(p.isCruising());
        p.onFix(60 * MPH, 60); // 55 deg swing: curve/exit
        assertFalse(p.isCruising());

        p.onFix(65 * MPH, 60);
        p.onFix(65 * MPH, 62);
        assertTrue(p.isCruising());
        p.onFix(25 * MPH, 62); // slowed down
        assertFalse(p.isCruising());
        assertEquals(8_000, p.intervalMs());
    }

    @Test
    public void unknownSpeedNeverStartsCruiseAndResetClears() {
        PacePolicy p = new PacePolicy();
        p.onFix(-1, Double.NaN);
        p.onFix(-1, Double.NaN);
        assertFalse(p.isCruising());
        p.onFix(70 * MPH, Double.NaN);
        p.onFix(70 * MPH, Double.NaN);
        assertTrue(p.isCruising());
        p.reset();
        assertFalse(p.isCruising());
    }
}
