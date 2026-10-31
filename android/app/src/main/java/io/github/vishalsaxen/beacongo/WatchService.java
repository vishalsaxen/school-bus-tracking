package io.github.vishalsaxen.beacongo;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.util.Date;
import java.util.Locale;

/**
 * Guardians app: watches the bus while the phone is locked.
 * Every ~20 seconds while the bus is live (every ~2 minutes otherwise) it reads the route
 * (routes/{Bus Captain's +91 number}) through the Firestore REST API, signed in as the guardian
 * with the refresh token the Guardians page handed over, and:
 *  - keeps a quiet notification up to date ("Bus 1.2 km from Sunrise Valley · about 4 min"),
 *  - alerts once per trip when the bus is about 5 minutes from the guardian's stop,
 *  - alerts when the Bus Captain presses Honk.
 */
public class WatchService extends Service {
    private static final String TAG = "Guardians";
    private static final String PREFS = "beacon";
    private static final String KEY_CONFIG = "watchConfig";
    private static final String CH_STATUS = "bus-status";
    private static final String CH_ALERTS = "bus-alerts";
    private static final int STATUS_ID = 2;
    private static final int ALERT_NEAR_ID = 3;
    private static final int ALERT_HONK_ID = 4;
    private static final String ACTION_POLL = "poll";

    private static final long LIVE_EVERY_MS = 20_000;
    private static final long IDLE_EVERY_MS = 120_000;
    private static final long STALE_MS = 3 * 60_000;
    private static final long HONK_FRESH_MS = 10 * 60_000;
    private static final int NEAR_MINUTES = 5;

    private static volatile boolean running;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock cpuLock;
    private JSONObject config;
    private String idToken;
    private long idTokenExpiresAt;
    private final Runnable pollTask = this::poll;

    // ---------- Called by MainActivity ----------
    /** Saves the config; returns true when it differs from the one saved before. */
    static boolean saveConfig(Context context, String json) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean changed = !json.equals(prefs.getString(KEY_CONFIG, null));
        prefs.edit().putString(KEY_CONFIG, json).apply();
        return changed;
    }

    static boolean isConfigured(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CONFIG, null) != null;
    }

    static boolean isRunning() {
        return running;
    }

    static void start(Context context) {
        context.startForegroundService(new Intent(context, WatchService.class));
    }

    static void stop(Context context) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_CONFIG).apply();
        context.stopService(new Intent(context, WatchService.class));
    }

    // ---------- Service ----------
    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("guardians-watch");
        thread.start();
        handler = new Handler(thread.getLooper());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Guardians:watch");
        cpuLock.setReferenceCounted(false);
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(status("Watching the school bus", "Starting…"));
        String json = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CONFIG, null);
        try {
            if (json == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            JSONObject next = new JSONObject(json);
            boolean sameUser = config != null && config.optString("refreshToken").equals(next.optString("refreshToken"));
            config = next;
            if (!sameUser) idToken = null;
        } catch (Exception e) {
            Log.e(TAG, "Bad watch config", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(pollTask);
        handler.post(pollTask);
        return START_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(STATUS_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(pollTask);
        cancelAlarm();
        if (cpuLock.isHeld()) cpuLock.release();
        thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Polling ----------
    private void poll() {
        boolean live = false;
        try {
            JSONObject doc = readRoute();
            live = handle(doc == null ? null : doc.optJSONObject("fields"));
        } catch (Exception e) {
            Log.w(TAG, "Poll failed", e);
            updateStatus("Watching the school bus", "No connection. Will try again.");
        }
        // Stay awake and check often while the bus is moving; otherwise let the phone sleep and
        // check every couple of minutes (an alarm wakes the phone from deep sleep for that).
        if (live) {
            cpuLock.acquire(LIVE_EVERY_MS * 3);
            handler.postDelayed(pollTask, LIVE_EVERY_MS);
        } else {
            if (cpuLock.isHeld()) cpuLock.release();
            handler.postDelayed(pollTask, IDLE_EVERY_MS);
            scheduleAlarm(IDLE_EVERY_MS + 30_000);
        }
    }

    /** Returns true when the bus is live. */
    private boolean handle(JSONObject f) throws Exception {
        String routeName = config.optString("routeName", "School bus");
        if (f == null) {
            updateStatus(routeName, "Can't see the bus. Open Guardians and sign in again.");
            return false;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = System.currentTimeMillis();

        // Honk
        long honkAt = num(f, "honkAt");
        long seenHonk = prefs.getLong("seenHonk", -1);
        if (seenHonk < 0) {
            prefs.edit().putLong("seenHonk", honkAt).apply();
        } else if (honkAt > seenHonk) {
            prefs.edit().putLong("seenHonk", honkAt).apply();
            if (now - honkAt < HONK_FRESH_MS) {
                String near = str(f, "honkStop");
                alert(ALERT_HONK_ID, "The Bus Captain honked", (near.isEmpty() ? "The bus is close." : "Near " + near + ".") + " Please bring your child out.");
            }
        }

        // Where the bus is
        JSONObject loc = map(f, "location");
        long updatedAt = timestamp(f, "updatedAt");
        boolean sharing = !f.has("sharing") || f.getJSONObject("sharing").optBoolean("booleanValue", true);
        boolean live = sharing && loc != null && now - updatedAt < STALE_MS;
        if (!live) {
            String when = updatedAt > 0 ? " · last seen " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(updatedAt)) : "";
            updateStatus(routeName, "Bus is not sharing now" + when);
            return false;
        }
        double lat = dbl(loc, "lat");
        double lng = dbl(loc, "lng");
        double speed = dbl(f, "speed");

        // The guardian's stop nearest to the bus.
        JSONArray stops = config.optJSONArray("stops");
        JSONObject best = null;
        double bestDist = Double.MAX_VALUE;
        for (int i = 0; stops != null && i < stops.length(); i++) {
            JSONObject s = stops.getJSONObject(i);
            double d = metres(lat, lng, s.getDouble("lat"), s.getDouble("lng"));
            if (d < bestDist) { bestDist = d; best = s; }
        }
        String kmh = Math.round(speed * 3.6) + " km/h";
        if (best == null) {
            updateStatus(routeName, "Bus is live · " + kmh);
            return true;
        }
        int minutes = etaMinutes(bestDist, speed);
        String stopName = best.optString("name", "your stop");
        updateStatus(routeName, "Bus " + distText(bestDist) + " from " + stopName + " · about " + minutes + " min · " + kmh);

        // Once per day, trip and stop: "about N min away".
        String trip = str(f, "trip");
        String key = "near:" + new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date()) + ":" + trip + ":" + best.optString("id");
        if (minutes <= NEAR_MINUTES && !prefs.getBoolean(key, false)) {
            prefs.edit().putBoolean(key, true).apply();
            alert(ALERT_NEAR_ID, "School bus is about " + minutes + " min away",
                "Bus is " + distText(bestDist) + " from " + stopName + ".");
        }
        return true;
    }

    private static int etaMinutes(double metres, double speedMps) {
        double v = speedMps > 2 ? speedMps : 20 / 3.6;
        return (int) Math.max(1, Math.ceil(metres * 1.3 / v / 60));
    }

    private static String distText(double m) {
        if (m < 1000) return (Math.round(m / 10) * 10) + " m";
        return String.format(Locale.US, "%.1f km", m / 1000);
    }

    private static double metres(double lat1, double lng1, double lat2, double lng2) {
        double r = 6371000;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double h = Math.pow(Math.sin(dLat / 2), 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
        return 2 * r * Math.asin(Math.sqrt(h));
    }

    // ---------- Firestore REST values ----------
    private static JSONObject map(JSONObject f, String key) {
        JSONObject v = f.optJSONObject(key);
        if (v == null || !v.has("mapValue")) return null;
        JSONObject inner = v.optJSONObject("mapValue").optJSONObject("fields");
        return inner;
    }

    private static double dbl(JSONObject f, String key) {
        JSONObject v = f.optJSONObject(key);
        if (v == null) return 0;
        if (v.has("doubleValue")) return v.optDouble("doubleValue", 0);
        if (v.has("integerValue")) return Double.parseDouble(v.optString("integerValue", "0"));
        return 0;
    }

    private static long num(JSONObject f, String key) {
        return (long) dbl(f, key);
    }

    private static String str(JSONObject f, String key) {
        JSONObject v = f.optJSONObject(key);
        return v == null ? "" : v.optString("stringValue", "");
    }

    private static long timestamp(JSONObject f, String key) {
        JSONObject v = f.optJSONObject(key);
        if (v == null || !v.has("timestampValue")) return 0;
        try {
            return Instant.parse(v.getString("timestampValue")).toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    // ---------- Network ----------
    /** The route document, or null when this guardian may not read it any more. */
    private JSONObject readRoute() throws Exception {
        String url = "https://firestore.googleapis.com/v1/projects/" + config.getString("projectId")
            + "/databases/(default)/documents/routes/" + URLEncoder.encode(config.getString("routeId"), "UTF-8");
        HttpURLConnection c = get(url, token(false));
        int status = c.getResponseCode();
        if (status == 401) {
            c.disconnect();
            c = get(url, token(true));
            status = c.getResponseCode();
        }
        if (status == 403 || status == 404) {
            Log.w(TAG, "Route read " + status + ": " + read(c.getErrorStream()));
            return null;
        }
        if (status >= 300) throw new IllegalStateException("Firestore answered " + status);
        String body = read(c.getInputStream());
        c.disconnect();
        return new JSONObject(body);
    }

    private String token(boolean forceRefresh) throws Exception {
        if (!forceRefresh && idToken != null && System.currentTimeMillis() < idTokenExpiresAt - 60_000) return idToken;
        String form = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(config.getString("refreshToken"), "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL("https://securetoken.googleapis.com/v1/token?key=" + config.getString("apiKey")).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15_000);
        c.setReadTimeout(15_000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream out = c.getOutputStream()) {
            out.write(form.getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        String text = read(status < 300 ? c.getInputStream() : c.getErrorStream());
        if (status >= 300) throw new IllegalStateException("Token refresh answered " + status + ": " + text);
        JSONObject res = new JSONObject(text);
        idToken = res.getString("id_token");
        idTokenExpiresAt = System.currentTimeMillis() + res.optLong("expires_in", 3600) * 1000;
        String newRefresh = res.optString("refresh_token", null);
        if (newRefresh != null && !newRefresh.equals(config.getString("refreshToken"))) {
            config.put("refreshToken", newRefresh);
            saveConfig(this, config.toString());
        }
        return idToken;
    }

    private static HttpURLConnection get(String url, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(15_000);
        c.setRequestProperty("Authorization", "Bearer " + bearer);
        return c;
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = s.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }

    // ---------- Alarm (wakes the phone from deep sleep for the slow checks) ----------
    private PendingIntent alarmIntent() {
        Intent i = new Intent(this, WatchService.class).setAction(ACTION_POLL);
        return PendingIntent.getService(this, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void scheduleAlarm(long inMs) {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (am != null) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + inMs, alarmIntent());
    }

    private void cancelAlarm() {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent());
    }

    // ---------- Notifications ----------
    private void channels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH_STATUS) == null) {
            NotificationChannel ch = new NotificationChannel(CH_STATUS, "Bus status", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Where the school bus is, updated while the bus is sharing");
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_ALERTS) == null) {
            NotificationChannel ch = new NotificationChannel(CH_ALERTS, "Bus alerts", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Bus about 5 minutes away, and Honk from the Bus Captain");
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[] {0, 300, 150, 300});
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent openApp() {
        return PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification status(String title, String text) {
        channels();
        return new Notification.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setColor(0xFFFFA41B)
            .build();
    }

    private void updateStatus(String title, String text) {
        getSystemService(NotificationManager.class).notify(STATUS_ID, status(title, text));
    }

    private void alert(int id, String title, String text) {
        channels();
        Notification n = new Notification.Builder(this, CH_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setColor(0xFFFFA41B)
            .build();
        getSystemService(NotificationManager.class).notify(id, n);
    }
}
