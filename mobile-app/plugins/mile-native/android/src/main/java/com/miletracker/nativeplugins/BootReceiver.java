package com.miletracker.nativeplugins;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts tracking after a reboot or an app update, if the user had it on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (TrackerHub.get(ctx).trackingEnabled()) {
            try {
                TripService.start(ctx);
            } catch (Exception ignored) {
                // Background start refused (no "Allow all the time"): the app restarts it when opened.
            }
        }
    }
}
