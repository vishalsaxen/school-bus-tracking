package io.github.vishalsaxen.beacongo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
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
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps sending the bus location to Firestore (routes/{Bus Captain's +91 number}) while the
 * phone is locked, as a foreground service with a "Sharing bus location" notification.
 * It writes the same location fields as the web page, through the Firestore REST API, signed in
 * as the Bus Captain with the Firebase refresh token the page handed over. Only the location
 * fields are written (update mask), so the route's stops, fees and guardians are left alone.
 */
public class TrackingService extends Service implements LocationListener {
    private static final String TAG = "BusCaptain";
    private static final String PREFS = "beacon";
    private static final String KEY_CONFIG = "trackingConfig";
    private static final String CHANNEL = "sharing";
    private static final int NOTIFICATION_ID = 1;
    private static final long FIX_EVERY_MS = 10_000;
    private static final long SEND_EVERY_MS = 15_000;

    private LocationManager locations;
    private HandlerThread locationThread;
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock cpuLock;
    private JSONObject config;
    private String idToken;
    private long idTokenExpiresAt;
    private volatile long lastSentAt;
    private volatile boolean sending;

    // ---------- Called by MainActivity ----------
    static void saveConfig(Context context, String json) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_CONFIG, json).apply();
    }

    static boolean isConfigured(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CONFIG, null) != null;
    }

    static void start(Context context) {
        context.startForegroundService(new Intent(context, TrackingService.class));
    }

    static void stop(Context context) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_CONFIG).apply();
        context.stopService(new Intent(context, TrackingService.class));
    }

    // ---------- Service ----------
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat(notification("Starting…"));
        String json = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CONFIG, null);
        try {
            JSONObject next = json == null ? null : new JSONObject(json);
            if (next == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            boolean sameChild = config != null && config.optString("docId").equals(next.optString("docId"));
            config = next;
            if (!sameChild) {
                idToken = null;
                lastSentAt = 0;
            }
        } catch (Exception e) {
            Log.e(TAG, "Bad tracking config", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        startLocationUpdates();
        updateNotification(childLabel() + " · finding location…");
        return START_STICKY; // restart after the system frees memory
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @SuppressWarnings("MissingPermission")
    private void startLocationUpdates() {
        if (locations != null) return;
        locations = (LocationManager) getSystemService(LOCATION_SERVICE);
        locationThread = new HandlerThread("beacon-location");
        locationThread.start();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BusCaptain:sharing");
        cpuLock.acquire();
        try {
            for (String provider : new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                if (locations.getAllProviders().contains(provider)) {
                    locations.requestLocationUpdates(provider, FIX_EVERY_MS, 0, this, locationThread.getLooper());
                }
            }
        } catch (SecurityException e) {
            updateNotification("Location permission is off. Open Bus Captain to allow it.");
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        long now = System.currentTimeMillis();
        // GPS and network both report; skip a rough network fix soon after a sharp GPS one.
        if (sending || now - lastSentAt < SEND_EVERY_MS) return;
        sending = true;
        lastSentAt = now;
        sender.execute(() -> {
            try {
                send(location);
                updateNotification(childLabel() + " · sent " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date()));
            } catch (Exception e) {
                Log.w(TAG, "Send failed", e);
                updateNotification(childLabel() + " · couldn't send, will retry");
                lastSentAt = 0;
            } finally {
                sending = false;
            }
        });
    }

    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}

    @Override
    public void onDestroy() {
        if (locations != null) locations.removeUpdates(this);
        if (locationThread != null) locationThread.quitSafely();
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        sender.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Firestore ----------
    private void send(Location location) throws Exception {
        String projectId = config.getString("projectId");
        String collection = config.optString("collection", "routes");
        String docName = "projects/" + projectId + "/databases/(default)/documents/" + collection + "/" + config.getString("docId");

        JSONObject fields = new JSONObject()
            .put("sharing", new JSONObject().put("booleanValue", true))
            .put("location", new JSONObject().put("mapValue", new JSONObject().put("fields", new JSONObject()
                .put("lat", dbl(location.getLatitude()))
                .put("lng", dbl(location.getLongitude()))
                .put("accuracy", integer(Math.round(location.getAccuracy()))))))
            .put("fixAt", integer(location.getTime()));
        if (location.hasSpeed()) fields.put("speed", dbl(Math.round(location.getSpeed() * 10) / 10.0));
        if (location.hasBearing()) fields.put("heading", integer(Math.round(location.getBearing())));
        int battery = batteryPercent();
        if (battery >= 0) fields.put("battery", integer(battery));

        JSONArray mask = new JSONArray();
        for (java.util.Iterator<String> it = fields.keys(); it.hasNext(); ) mask.put(it.next());

        JSONObject write = new JSONObject()
            .put("update", new JSONObject().put("name", docName).put("fields", fields))
            .put("updateMask", new JSONObject().put("fieldPaths", mask))
            .put("updateTransforms", new JSONArray().put(new JSONObject()
                .put("fieldPath", "updatedAt").put("setToServerValue", "REQUEST_TIME")));
        JSONObject body = new JSONObject().put("writes", new JSONArray().put(write));

        String url = "https://firestore.googleapis.com/v1/projects/" + projectId + "/databases/(default)/documents:commit";
        int status = post(url, body.toString(), "application/json", token(false));
        if (status == 401) status = post(url, body.toString(), "application/json", token(true));
        if (status >= 300) throw new IllegalStateException("Firestore answered " + status);
    }

    /** A Firebase ID token for the child, refreshed shortly before it expires. */
    private String token(boolean forceRefresh) throws Exception {
        if (!forceRefresh && idToken != null && System.currentTimeMillis() < idTokenExpiresAt - 60_000) return idToken;
        String form = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(config.getString("refreshToken"), "UTF-8");
        HttpURLConnection c = open("https://securetoken.googleapis.com/v1/token?key=" + config.getString("apiKey"), "application/x-www-form-urlencoded", null);
        write(c, form);
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

    private int post(String url, String body, String type, String bearer) throws Exception {
        HttpURLConnection c = open(url, type, bearer);
        write(c, body);
        int status = c.getResponseCode();
        if (status >= 300) Log.w(TAG, "POST " + status + ": " + read(c.getErrorStream()));
        c.disconnect();
        return status;
    }

    private static HttpURLConnection open(String url, String type, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15_000);
        c.setReadTimeout(15_000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", type);
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        return c;
    }

    private static void write(HttpURLConnection c, String body) throws Exception {
        try (OutputStream out = c.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
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

    private static JSONObject str(String v) throws Exception { return new JSONObject().put("stringValue", v); }
    private static JSONObject integer(long v) throws Exception { return new JSONObject().put("integerValue", String.valueOf(v)); }
    private static JSONObject dbl(double v) throws Exception { return new JSONObject().put("doubleValue", v); }

    private int batteryPercent() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return -1;
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        return level < 0 || scale <= 0 ? -1 : Math.round(level * 100f / scale);
    }

    // ---------- Notification ----------
    private String childLabel() {
        if (config == null) return "Bus Captain";
        return config.optString("label", "Bus");
    }

    private Notification notification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while Bus Captain is sharing the bus location with guardians");
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle("Sharing bus location with guardians")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setColor(0xFF0B1B4D)
            .build();
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }
}
