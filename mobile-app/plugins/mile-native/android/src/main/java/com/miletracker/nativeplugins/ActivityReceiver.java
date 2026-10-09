package com.miletracker.nativeplugins;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionResult;
import com.google.android.gms.location.DetectedActivity;

/** "Entered a vehicle" from Activity Recognition: switch to GPS for a few minutes. */
public class ActivityReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        for (ActivityTransitionEvent e : result.getTransitionEvents()) {
            if (e.getActivityType() == DetectedActivity.IN_VEHICLE) {
                TrackerHub hub = TrackerHub.get(ctx);
                hub.boost();
                if (hub.trackingEnabled()) {
                    try {
                        TripService.start(ctx); // also re-applies the location mode
                    } catch (Exception ignored) {
                    }
                }
                return;
            }
        }
    }
}
