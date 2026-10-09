package com.miletracker.nativeplugins;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.DetectedActivity;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Always-on foreground service (type "location") that feeds the TripDetector.
 * Power policy: balanced (Wi-Fi/cell) fixes every 30 s while parked, GPS every
 * 5 s while driving or while probing a possible departure. Activity Recognition
 * ("entered a vehicle") also starts a probe when that permission is granted.
 */
public class TripService extends Service {
    public static final String ACTION_BOOST = "com.miletracker.BOOST";
    private static final String CHANNEL_ID = "mile_tracking";
    private static final int NOTIFICATION_ID = 5101;

    private FusedLocationProviderClient fused;
    private HandlerThread thread;
    private Handler handler;
    private Boolean highMode;
    private TrackerHub hub;

    public static void start(Context ctx) {
        ContextCompat.startForegroundService(ctx, new Intent(ctx, TripService.class));
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, TripService.class));
    }

    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(@NonNull LocationResult result) {
            for (Location l : result.getLocations()) {
                float speed = l.hasSpeed() ? l.getSpeed() : -1f;
                float acc = l.hasAccuracy() ? l.getAccuracy() : 999f;
                hub.onFix(new TripDetector.Fix(l.getLatitude(), l.getLongitude(), acc, speed, l.getTime()));
            }
            applyMode();
            updateNotification();
        }
    };

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            hub.onTick(System.currentTimeMillis());
            applyMode();
            updateNotification();
            handler.postDelayed(this, 60_000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        hub = TrackerHub.get(this);
        fused = LocationServices.getFusedLocationProviderClient(this);
        thread = new HandlerThread("mile-tracker");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!startInForeground()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_BOOST.equals(intent.getAction())) hub.boost();
        handler.post(() -> {
            highMode = null; // force a (re)request
            applyMode();
            handler.removeCallbacks(ticker);
            handler.postDelayed(ticker, 60_000);
        });
        requestActivityTransitions();
        hub.uploadAsync();
        return START_STICKY;
    }

    private boolean startInForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Mileage tracking", NotificationManager.IMPORTANCE_MIN));
        }
        try {
            int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
            return true;
        } catch (Exception e) {
            // No location permission (or started from the background without "Allow all the time").
            return false;
        }
    }

    private Notification buildNotification() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = launch == null ? null : PendingIntent.getActivity(
                this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = hub.isDriving()
                ? String.format(Locale.US, "Recording a drive · %.1f mi", hub.currentMiles())
                : "Waiting for your next drive";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_mt_notify)
                .setContentTitle("Mile Tracker")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(content)
                .build();
    }

    private void updateNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        try {
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
        } catch (SecurityException ignored) {
        }
    }

    @SuppressLint("MissingPermission")
    private void applyMode() {
        boolean high = hub.wantsHighAccuracy();
        if (highMode != null && highMode == high) return;
        highMode = high;
        LocationRequest req = high
                ? new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5_000)
                    .setMinUpdateIntervalMillis(2_000)
                    .build()
                : new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 30_000)
                    .setMinUpdateIntervalMillis(15_000)
                    .build();
        try {
            fused.removeLocationUpdates(callback);
            fused.requestLocationUpdates(req, callback, thread.getLooper());
        } catch (SecurityException e) {
            stopSelf();
        }
    }

    @SuppressLint("MissingPermission")
    private void requestActivityTransitions() {
        if (Build.VERSION.SDK_INT >= 29 && ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACTIVITY_RECOGNITION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        List<ActivityTransition> list = new ArrayList<>();
        list.add(new ActivityTransition.Builder()
                .setActivityType(DetectedActivity.IN_VEHICLE)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                .build());
        Intent i = new Intent(this, ActivityReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getBroadcast(this, 7, i, flags);
        try {
            ActivityRecognition.getClient(this).requestActivityTransitionUpdates(new ActivityTransitionRequest(list), pi);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        try {
            fused.removeLocationUpdates(callback);
        } catch (Exception ignored) {
        }
        handler.removeCallbacksAndMessages(null);
        thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
