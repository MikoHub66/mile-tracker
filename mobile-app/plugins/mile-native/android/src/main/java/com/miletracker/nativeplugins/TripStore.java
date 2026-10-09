package com.miletracker.nativeplugins;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Trips recorded on this phone, in files/trips.json. Each entry has the same
 * fields as the Firestore document plus "id" and "uploaded". Uploaded trips are
 * pruned after 30 days (the cloud copy is the source of truth after upload).
 */
public class TripStore {
    private static final long KEEP_UPLOADED_MS = 30L * 24 * 3600 * 1000;
    private final File file;

    public TripStore(Context ctx) {
        file = new File(ctx.getFilesDir(), "trips.json");
    }

    public synchronized List<JSONObject> list() {
        List<JSONObject> out = new ArrayList<>();
        JSONArray arr = read();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null) out.add(o);
        }
        return out;
    }

    public synchronized void add(JSONObject trip) {
        JSONArray arr = read();
        arr.put(trip);
        write(prune(arr));
    }

    /** Merges `fields` into the trip. Returns the updated trip or null. */
    public synchronized JSONObject update(String id, JSONObject fields) {
        JSONArray arr = read();
        JSONObject hit = null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) {
                hit = o;
                Iterator<String> keys = fields.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    try {
                        o.put(k, fields.get(k));
                    } catch (JSONException ignored) {
                    }
                }
            }
        }
        if (hit != null) write(arr);
        return hit;
    }

    public synchronized boolean delete(String id) {
        JSONArray arr = read();
        JSONArray keep = new JSONArray();
        boolean removed = false;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) removed = true;
            else if (o != null) keep.put(o);
        }
        if (removed) write(keep);
        return removed;
    }

    public synchronized int pendingCount() {
        int n = 0;
        for (JSONObject o : list()) if (!o.optBoolean("uploaded")) n++;
        return n;
    }

    private JSONArray prune(JSONArray arr) {
        long cutoff = System.currentTimeMillis() - KEEP_UPLOADED_MS;
        JSONArray keep = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            if (o.optBoolean("uploaded") && o.optLong("endTs") < cutoff) continue;
            keep.put(o);
        }
        return keep;
    }

    private JSONArray read() {
        if (!file.exists()) return new JSONArray();
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[(int) file.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            return new JSONArray(new String(buf, 0, off, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void write(JSONArray arr) {
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (Exception e) {
            return;
        }
        if (!tmp.renameTo(file)) {
            file.delete();
            tmp.renameTo(file);
        }
    }
}
