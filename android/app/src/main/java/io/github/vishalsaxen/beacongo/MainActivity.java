package io.github.vishalsaxen.beacongo;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Bus Captain as an installed app: the same Bus Captain page as the website, inside a WebView,
 * plus a bridge (window.BeaconAndroid) that hands the signed-in Bus Captain's route to
 * TrackingService so the bus location keeps reaching guardians while the screen is locked.
 */
public class MainActivity extends Activity {
    static final String SITE = BuildConfig.SITE;
    private static final String SITE_ORIGIN = "https://vishalsaxen.github.io/school-bus-tracking/";
    private static final int REQ_LOCATION = 1;
    private static final int REQ_NOTIFICATIONS = 2;
    private static final int REQ_UPI = 3;
    private static final String CH_APP_ALERTS = "app-alerts";
    private int alertId = 100;

    private WebView web;
    private volatile String currentUrl = SITE;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String url = uri.toString();
                // Our pages and Google sign-in/reCAPTCHA frames stay in the app; everything
                // else (maps links, sms:, tel:) opens in the phone's own apps.
                if (url.startsWith(SITE_ORIGIN) || url.startsWith("https://www.google.com/recaptcha")
                        || url.contains(".firebaseapp.com/")) {
                    return false;
                }
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                currentUrl = url;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeo = callback;
                    pendingGeoOrigin = origin;
                    requestPermissions(new String[] {
                        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
                    }, REQ_LOCATION);
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "BeaconAndroid");
        web.loadUrl(SITE);

        // The phone may have been restarted or the app swiped away: carry on sharing if it was on.
        if (TrackingService.isConfigured(this)) TrackingService.start(this);
        if (WatchService.isConfigured(this)) WatchService.start(this);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No app handles this link; nothing to open.
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_LOCATION && pendingGeo != null) {
            pendingGeo.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeo = null;
        }
        if (requestCode == REQ_LOCATION && hasLocationPermission() && TrackingService.isConfigured(this)) {
            TrackingService.start(this);
        }
    }

    /** The UPI app's answer to a payment, handed to the Guardians page as JSON. */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_UPI) return;
        org.json.JSONObject res = new org.json.JSONObject();
        try {
            // UPI apps answer with e.g. "txnId=…&responseCode=00&Status=SUCCESS&txnRef=…".
            String response = data == null ? null : data.getStringExtra("response");
            if (response == null && data != null) response = data.getStringExtra("Status") != null ? "Status=" + data.getStringExtra("Status") : null;
            if (response != null) {
                for (String part : response.split("&")) {
                    int eq = part.indexOf('=');
                    if (eq <= 0) continue;
                    String key = part.substring(0, eq).trim();
                    String value = Uri.decode(part.substring(eq + 1).trim());
                    String k = key.toLowerCase(java.util.Locale.US);
                    if (k.equals("status")) res.put("status", value);
                    else if (k.equals("txnid")) res.put("txnId", value);
                    else if (k.equals("txnref")) res.put("txnRef", value);
                    else if (k.equals("approvalrefno")) res.put("approvalRefNo", value);
                    else if (k.equals("responsecode")) res.put("responseCode", value);
                }
            }
            if (!res.has("status")) res.put("status", resultCode == RESULT_CANCELED ? "UNKNOWN" : "SUBMITTED");
        } catch (Exception ignored) {
            // Leave status out; the page asks the guardian instead.
        }
        sendUpiResult(res.toString());
    }

    private void sendUpiResult(String json) {
        web.evaluateJavascript("window.onUpiResult && window.onUpiResult(" + org.json.JSONObject.quote(json) + ")", null);
    }

    private void showAlert(String title, String text) {
        android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class);
        if (nm.getNotificationChannel(CH_APP_ALERTS) == null) {
            android.app.NotificationChannel ch = new android.app.NotificationChannel(CH_APP_ALERTS, "Alerts", android.app.NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Fee payments and Child not going alerts");
            nm.createNotificationChannel(ch);
        }
        android.app.PendingIntent open = android.app.PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(alertId++, new android.app.Notification.Builder(this, CH_APP_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_beacon)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(0xFFFFA41B)
            .build());
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** Ask once to be left out of battery saving, so phone makers' power savers don't stop sharing. */
    @SuppressLint("BatteryLife")
    private void askToSkipBatteryOptimisation() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        SharedPreferences prefs = getSharedPreferences("beacon", MODE_PRIVATE);
        if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        if (prefs.getBoolean("askedBattery", false)) return;
        prefs.edit().putBoolean("askedBattery", true).apply();
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) {
            // Some phones hide this screen; sharing still works, it may just pause sooner.
        }
    }

    /** Called from the Bus Captain page's JavaScript. */
    private class Bridge {
        private boolean fromOurPage() {
            return currentUrl != null && currentUrl.startsWith(SITE_ORIGIN);
        }

        /** config: JSON with apiKey, projectId, collection, docId, refreshToken, label. */
        @JavascriptInterface
        public void startTracking(String config) {
            if (!fromOurPage() || !"captain".equals(BuildConfig.FLAVOR)) return;
            runOnUiThread(() -> {
                TrackingService.saveConfig(MainActivity.this, config);
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFICATIONS);
                }
                if (hasLocationPermission()) TrackingService.start(MainActivity.this);
                askToSkipBatteryOptimisation();
            });
        }

        @JavascriptInterface
        public void stopTracking() {
            if (!fromOurPage()) return;
            runOnUiThread(() -> TrackingService.stop(MainActivity.this));
        }

        /** Guardians app: config JSON with apiKey, projectId, routeId, refreshToken, stops, routeName. */
        @JavascriptInterface
        public void startWatching(String config) {
            if (!fromOurPage() || !"guardian".equals(BuildConfig.FLAVOR)) return;
            runOnUiThread(() -> {
                boolean changed = WatchService.saveConfig(MainActivity.this, config);
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFICATIONS);
                }
                if (changed || !WatchService.isRunning()) WatchService.start(MainActivity.this);
                askToSkipBatteryOptimisation();
            });
        }

        @JavascriptInterface
        public void stopWatching() {
            if (!fromOurPage()) return;
            runOnUiThread(() -> WatchService.stop(MainActivity.this));
        }

        @JavascriptInterface
        public boolean isWatching() {
            return WatchService.isConfigured(MainActivity.this);
        }

        /** Guardians app: opens a upi://pay link and reports the result to window.onUpiResult. */
        @JavascriptInterface
        public void payUpi(String url) {
            if (!fromOurPage() || !"guardian".equals(BuildConfig.FLAVOR) || url == null || !url.startsWith("upi://pay")) return;
            runOnUiThread(() -> {
                Intent pay = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                if (pay.resolveActivity(getPackageManager()) == null) {
                    sendUpiResult("{\"status\":\"NO_APP\"}");
                    return;
                }
                try {
                    startActivityForResult(Intent.createChooser(pay, "Pay with"), REQ_UPI);
                } catch (ActivityNotFoundException e) {
                    sendUpiResult("{\"status\":\"NO_APP\"}");
                }
            });
        }

        /** Shows a phone notification (fee paid, child not going, …). */
        @JavascriptInterface
        public void showNotification(String title, String text) {
            if (!fromOurPage()) return;
            runOnUiThread(() -> showAlert(title, text));
        }

        @JavascriptInterface
        public boolean isTracking() {
            return TrackingService.isConfigured(MainActivity.this);
        }
    }
}
