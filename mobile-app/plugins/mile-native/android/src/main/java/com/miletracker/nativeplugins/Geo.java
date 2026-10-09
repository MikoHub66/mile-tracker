package com.miletracker.nativeplugins;

import java.util.List;

/** Distance and Google encoded-polyline helpers (match web/public/shared/trips.js). */
public final class Geo {
    private Geo() {}

    public static final double METERS_PER_MILE = 1609.344;

    public static double distance(double lat1, double lng1, double lat2, double lng2) {
        final double r = 6371008.8;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    public static String encodePolyline(List<double[]> points) {
        StringBuilder sb = new StringBuilder();
        long pLat = 0, pLng = 0;
        for (double[] p : points) {
            long lat = Math.round(p[0] * 1e5);
            long lng = Math.round(p[1] * 1e5);
            encode(lat - pLat, sb);
            encode(lng - pLng, sb);
            pLat = lat;
            pLng = lng;
        }
        return sb.toString();
    }

    private static void encode(long v, StringBuilder sb) {
        v = v < 0 ? ~(v << 1) : v << 1;
        while (v >= 0x20) {
            sb.append((char) ((0x20 | (v & 0x1f)) + 63));
            v >>= 5;
        }
        sb.append((char) (v + 63));
    }
}
