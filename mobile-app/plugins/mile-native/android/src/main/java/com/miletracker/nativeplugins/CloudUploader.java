package com.miletracker.nativeplugins;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;

/**
 * Uploads trips recorded in the background straight to Firestore over REST, so
 * they reach the web map without opening the app. The JS side hands over the
 * Firebase web config and the signed-in user's refresh token (setCloud).
 *
 * Trips are created with documentId = trip id; 409 (already exists) counts as
 * uploaded, so a retry never overwrites edits made on the web map.
 */
public class CloudUploader {
    private static final String PREFS = "mile_cloud";
    private final Context ctx;
    private String idToken;
    private long idTokenExpires;
    public volatile String lastError = "";
    public volatile long lastUploadTs;

    public CloudUploader(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public void configure(String apiKey, String projectId, String uid, String refreshToken) {
        prefs().edit()
                .putString("apiKey", apiKey)
                .putString("projectId", projectId)
                .putString("uid", uid)
                .putString("refreshToken", refreshToken)
                .apply();
        idToken = null;
        lastError = "";
    }

    public void clear() {
        prefs().edit().clear().apply();
        idToken = null;
    }

    public boolean isConfigured() {
        SharedPreferences p = prefs();
        return !p.getString("refreshToken", "").isEmpty() && !p.getString("projectId", "").isEmpty();
    }

    public String uid() {
        return prefs().getString("uid", "");
    }

    /** Uploads every trip not yet uploaded. Call from a background thread. */
    public synchronized int uploadPending(TripStore store) {
        if (!isConfigured()) return 0;
        int sent = 0;
        List<JSONObject> trips = store.list();
        for (JSONObject t : trips) {
            if (t.optBoolean("uploaded")) continue;
            try {
                int code = create(t);
                if (code == 200 || code == 409) {
                    store.update(t.getString("id"), new JSONObject().put("uploaded", true));
                    sent++;
                    lastError = "";
                    lastUploadTs = System.currentTimeMillis();
                } else {
                    lastError = "Upload failed (HTTP " + code + ")";
                    if (code == 401 || code == 403) idToken = null;
                    break;
                }
            } catch (Exception e) {
                lastError = "Upload failed: " + e.getMessage();
                break;
            }
        }
        return sent;
    }

    private int create(JSONObject trip) throws Exception {
        String token = token();
        SharedPreferences p = prefs();
        String url = "https://firestore.googleapis.com/v1/projects/" + p.getString("projectId", "")
                + "/databases/(default)/documents/users/" + p.getString("uid", "")
                + "/trips?documentId=" + URLEncoder.encode(trip.getString("id"), "UTF-8");
        JSONObject fields = new JSONObject();
        Iterator<String> keys = trip.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (k.equals("id") || k.equals("uploaded")) continue;
            fields.put(k, value(trip.get(k)));
        }
        long now = System.currentTimeMillis();
        fields.put("createdAt", value(now));
        fields.put("updatedAt", value(now));
        JSONObject body = new JSONObject().put("fields", fields);

        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        c.setDoOutput(true);
        try (OutputStream out = c.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        c.disconnect();
        return code;
    }

    private static JSONObject value(Object v) throws Exception {
        JSONObject o = new JSONObject();
        if (v == null || v == JSONObject.NULL) o.put("nullValue", JSONObject.NULL);
        else if (v instanceof Boolean) o.put("booleanValue", v);
        else if (v instanceof Integer || v instanceof Long) o.put("integerValue", String.valueOf(v));
        else if (v instanceof Number) o.put("doubleValue", ((Number) v).doubleValue());
        else o.put("stringValue", String.valueOf(v));
        return o;
    }

    /** Exchanges the refresh token for an ID token (cached until shortly before expiry). */
    private String token() throws Exception {
        if (idToken != null && System.currentTimeMillis() < idTokenExpires) return idToken;
        SharedPreferences p = prefs();
        URL url = new URL("https://securetoken.googleapis.com/v1/token?key=" + p.getString("apiKey", ""));
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        c.setDoOutput(true);
        String form = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(p.getString("refreshToken", ""), "UTF-8");
        try (OutputStream out = c.getOutputStream()) {
            out.write(form.getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        String text = readAll(code < 400 ? c.getInputStream() : c.getErrorStream());
        c.disconnect();
        if (code != 200) throw new Exception("sign-in expired, open the app and sign in again (" + code + ")");
        JSONObject r = new JSONObject(text);
        idToken = r.getString("id_token");
        idTokenExpires = System.currentTimeMillis() + (Long.parseLong(r.optString("expires_in", "3600")) - 300) * 1000;
        String newRefresh = r.optString("refresh_token", "");
        if (!newRefresh.isEmpty()) p.edit().putString("refreshToken", newRefresh).apply();
        return idToken;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[4096];
        int n;
        while ((n = in.read(b)) > 0) buf.write(b, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }
}
