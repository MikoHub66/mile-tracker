package com.miletracker.nativeplugins;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/**
 * JS API: window.Capacitor.Plugins.MileTracker
 *
 *   getStatus()                       -> status + permissions
 *   requestPermission({kind})         kind: location | background | activity | notifications | bluetooth
 *   listBluetoothDevices()            -> { devices: [{name, address}] }  paired devices (car stereos)
 *   requestBatteryExemption()         opens the "ignore battery optimisation" prompt
 *   openAppSettings()
 *   start() / stop()                  turn background tracking on/off (survives reboots)
 *   setConfig({vehicleId, vehicleName, highAccuracyAlways, automation})
 *       automation: {vehicles:[{id,name,btAddress,defaultUse}], places:[{name,lat,lng,radius,use}],
 *                    workHours:{on,days:[0-6],start,end,use}, requireBluetooth}
 *   setCloud({apiKey, projectId, uid, refreshToken}) / clearCloud()
 *   getTrips()                        -> { trips: [...] }  trips recorded on this phone
 *   updateTrip({id, fields}) / deleteTrip({id})
 *   syncNow()                         upload pending trips now
 *   getParked()                       -> { parked: {lat,lng,acc,ts,source,vehicle} | null, driving }
 *
 * Events: "status", "tripSaved".
 */
@CapacitorPlugin(
        name = "MileTracker",
        permissions = {
                @Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}),
                @Permission(alias = "background", strings = {Manifest.permission.ACCESS_BACKGROUND_LOCATION}),
                @Permission(alias = "activity", strings = {Manifest.permission.ACTIVITY_RECOGNITION}),
                @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS}),
                @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_CONNECT}),
        }
)
public class TripPlugin extends Plugin implements TrackerHub.Events {
    private TrackerHub hub;

    @Override
    public void load() {
        hub = TrackerHub.get(getContext());
        hub.setEvents(this);
        // Opening the app restarts tracking if Android stopped the service.
        if (hub.trackingEnabled() && granted("location")) {
            try {
                TripService.start(getContext());
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onTripSaved(JSONObject trip) {
        try {
            notifyListeners("tripSaved", JSObject.fromJSONObject(trip));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onStatus(JSONObject status) {
        try {
            notifyListeners("status", JSObject.fromJSONObject(status));
        } catch (Exception ignored) {
        }
    }

    private boolean granted(String alias) {
        if (alias.equals("background") && Build.VERSION.SDK_INT < 29) return granted("location");
        if (alias.equals("activity") && Build.VERSION.SDK_INT < 29) return true;
        if (alias.equals("notifications") && Build.VERSION.SDK_INT < 33) return true;
        if (alias.equals("bluetooth") && Build.VERSION.SDK_INT < 31) return true;
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private JSObject permissions() {
        JSObject p = new JSObject();
        p.put("location", granted("location"));
        p.put("background", granted("background"));
        p.put("activity", granted("activity"));
        p.put("notifications", granted("notifications"));
        p.put("bluetooth", granted("bluetooth"));
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        p.put("batteryExempt", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        return p;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        try {
            JSObject s = JSObject.fromJSONObject(hub.status());
            s.put("permissions", permissions());
            s.put("highAccuracyAlways", hub.highAccuracyAlways());
            call.resolve(s);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        String kind = call.getString("kind", "location");
        if (granted(kind)) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        if (kind.equals("background") && !granted("location")) {
            call.reject("Allow location first");
            return;
        }
        requestPermissionForAlias(kind, call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        call.resolve(new JSObject().put("granted", granted(call.getString("kind", "location"))));
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!granted("location")) {
            call.reject("Location permission is required");
            return;
        }
        hub.prefs().edit().putBoolean("enabled", true).apply();
        try {
            TripService.start(getContext());
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        hub.prefs().edit().putBoolean("enabled", false).apply();
        TripService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setConfig(PluginCall call) {
        android.content.SharedPreferences.Editor e = hub.prefs().edit();
        if (call.hasOption("vehicleId")) e.putString("vehicleId", call.getString("vehicleId", ""));
        if (call.hasOption("vehicleName")) e.putString("vehicleName", call.getString("vehicleName", ""));
        if (call.hasOption("automation")) e.putString("automation", call.getObject("automation", new JSObject()).toString());
        if (call.hasOption("highAccuracyAlways")) e.putBoolean("highAccuracyAlways", Boolean.TRUE.equals(call.getBoolean("highAccuracyAlways")));
        e.apply();
        if (hub.trackingEnabled() && call.hasOption("highAccuracyAlways")) {
            try {
                TripService.start(getContext());
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void listBluetoothDevices(PluginCall call) {
        if (!granted("bluetooth")) {
            call.reject("Bluetooth permission is required");
            return;
        }
        JSArray arr = new JSArray();
        try {
            BluetoothManager bm = getContext().getSystemService(BluetoothManager.class);
            BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
            if (ad != null) for (BluetoothDevice d : ad.getBondedDevices()) {
                String name = d.getName() == null ? d.getAddress() : d.getName();
                arr.put(new JSObject().put("name", name).put("address", d.getAddress()));
            }
        } catch (SecurityException e) {
            call.reject("Bluetooth permission is required");
            return;
        }
        call.resolve(new JSObject().put("devices", arr));
    }

    @PluginMethod
    public void setCloud(PluginCall call) {
        hub.uploader.configure(call.getString("apiKey", ""), call.getString("projectId", ""),
                call.getString("uid", ""), call.getString("refreshToken", ""));
        hub.uploadAsync();
        call.resolve();
    }

    @PluginMethod
    public void clearCloud(PluginCall call) {
        hub.uploader.clear();
        call.resolve();
    }

    @PluginMethod
    public void getTrips(PluginCall call) {
        JSArray arr = new JSArray();
        for (JSONObject o : hub.store.list()) arr.put(o);
        call.resolve(new JSObject().put("trips", arr));
    }

    @PluginMethod
    public void updateTrip(PluginCall call) {
        String id = call.getString("id", "");
        JSObject fields = call.getObject("fields", new JSObject());
        JSONObject t = hub.store.update(id, fields);
        if (t == null) {
            call.reject("Trip not found");
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(t));
        } catch (Exception e) {
            call.resolve();
        }
    }

    @PluginMethod
    public void deleteTrip(PluginCall call) {
        call.resolve(new JSObject().put("deleted", hub.store.delete(call.getString("id", ""))));
    }

    @PluginMethod
    public void getParked(PluginCall call) {
        JSONObject p = hub.parked();
        JSObject out = new JSObject();
        try {
            out.put("parked", p == null ? JSONObject.NULL : JSObject.fromJSONObject(p));
            out.put("driving", hub.isDriving());
        } catch (Exception ignored) {
        }
        call.resolve(out);
    }

    @PluginMethod
    public void syncNow(PluginCall call) {
        hub.uploadAsync();
        call.resolve();
    }
}
