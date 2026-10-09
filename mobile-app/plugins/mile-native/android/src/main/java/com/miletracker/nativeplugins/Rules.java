package com.miletracker.nativeplugins;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.TimeZone;

/**
 * Automatic classification for newly detected trips (pure Java, unit tested).
 * Priority: plane speed > no car Bluetooth (if required) > saved place >
 * vehicle default use > work hours. Anything else stays "unclassified".
 */
public class Rules {
    public static class Place {
        public String name, use;
        public double lat, lng, radiusM;

        public Place(String name, double lat, double lng, double radiusM, String use) {
            this.name = name;
            this.lat = lat;
            this.lng = lng;
            this.radiusM = radiusM;
            this.use = use;
        }
    }

    public static class Result {
        public String use = "unclassified";
        public String rule = "";          // what decided it, shown as the "auto" badge
        public boolean excluded;
        public String excludedReason = "";
        public String startPlace = "", endPlace = "";
    }

    public static final double PLANE_AVG_MS = 50; // ~112 mph average: nobody drives that

    public List<Place> places = new ArrayList<>();
    public String vehicleDefaultUse = "";
    public boolean requireBluetooth;
    public boolean workHoursOn;
    public boolean[] workDays = {false, true, true, true, true, true, false}; // Sun..Sat
    public int workStartMin = 7 * 60, workEndMin = 17 * 60;
    public String workUse = "";

    public Result classify(TripDetector.Trip t, boolean btMatched, TimeZone tz) {
        Result r = new Result();
        Place sp = placeAt(t.startLat, t.startLng);
        Place ep = placeAt(t.endLat, t.endLng);
        if (sp != null) r.startPlace = sp.name;
        if (ep != null) r.endPlace = ep.name;

        double secs = Math.max(1, (t.endTs - t.startTs) / 1000.0);
        if (t.meters / secs > PLANE_AVG_MS) {
            r.excluded = true;
            r.excludedReason = "plane";
            r.rule = "speed";
            return r;
        }
        if (requireBluetooth && !btMatched) {
            r.excluded = true;
            r.excludedReason = "passenger";
            r.rule = "no car Bluetooth";
            return r;
        }
        // A business place at either end wins over a personal one (e.g. Home -> Office).
        Place byPlace = null;
        for (Place p : new Place[]{ep, sp}) {
            if (p == null || p.use == null || p.use.isEmpty()) continue;
            if (byPlace == null || (byPlace.use.equals("personal") && !p.use.equals("personal"))) byPlace = p;
        }
        if (byPlace != null) {
            r.use = byPlace.use;
            r.rule = "place: " + byPlace.name;
            return r;
        }
        if (vehicleDefaultUse != null && !vehicleDefaultUse.isEmpty()) {
            r.use = vehicleDefaultUse;
            r.rule = "vehicle";
            return r;
        }
        if (workHoursOn && workUse != null && !workUse.isEmpty()) {
            Calendar c = Calendar.getInstance(tz);
            c.setTimeInMillis(t.startTs);
            int day = c.get(Calendar.DAY_OF_WEEK) - 1;
            int min = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
            if (workDays[day] && min >= workStartMin && min < workEndMin) {
                r.use = workUse;
                r.rule = "work hours";
            }
        }
        return r;
    }

    Place placeAt(double lat, double lng) {
        Place best = null;
        double bestD = Double.MAX_VALUE;
        for (Place p : places) {
            double d = Geo.distance(lat, lng, p.lat, p.lng);
            if (d <= p.radiusM && d < bestD) {
                best = p;
                bestD = d;
            }
        }
        return best;
    }
}
