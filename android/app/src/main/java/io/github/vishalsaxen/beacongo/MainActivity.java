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
    static final String SITE = "https://vishalsaxen.github.io/school-bus-tracking/bus-captain/";
    private static final String SITE_ORIGIN = "https://vishalsaxen.github.io/school-bus-tracking/";
    private static final int REQ_LOCATION = 1;
    private static final int REQ_NOTIFICATIONS = 2;

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
            if (!fromOurPage()) return;
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

        @JavascriptInterface
        public boolean isTracking() {
            return TrackingService.isConfigured(MainActivity.this);
        }
    }
}
