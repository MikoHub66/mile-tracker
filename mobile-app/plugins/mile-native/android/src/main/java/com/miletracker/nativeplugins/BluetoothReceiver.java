package com.miletracker.nativeplugins;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Car stereo connected / disconnected (ACL broadcasts are exempt from Android's
 * implicit-broadcast limits, so this works with the app closed).
 */
public class BluetoothReceiver extends BroadcastReceiver {
    @SuppressLint("MissingPermission")
    @Override
    public void onReceive(Context ctx, Intent intent) {
        BluetoothDevice dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
        if (dev == null) return;
        String address;
        try {
            address = dev.getAddress();
        } catch (SecurityException e) {
            return;
        }
        boolean connected = BluetoothDevice.ACTION_ACL_CONNECTED.equals(intent.getAction());
        TrackerHub hub = TrackerHub.get(ctx);
        if (hub.onBluetooth(address, connected) && connected && hub.trackingEnabled()) {
            try {
                TripService.start(ctx); // re-applies GPS mode after the boost
            } catch (Exception ignored) {
            }
        }
    }
}
