package lt.voicech311;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    static MainActivity instance;
    private AlwaysVisibleWebView web;
    private PermissionRequest pendingWebPermission;
    private static final int REQ_PERMS = 31;
    private static final int REQ_BT = 32;
    private static final int REQ_LOC = 33;
    private android.webkit.GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Leidus vietą – fono paslauga papildomai pažymima kaip „vieta“, kad GPS veiktų užrakinus ekraną. */
    private void refreshServiceTypes() {
        try { startForegroundService(new Intent(this, VoiceService.class).setAction(VoiceService.ACTION_UPDATE_TYPES)); } catch (Exception ignored) {}
    }

    /** WebView, kuris nesužino, kad ekranas užrakintas: puslapis neužmigdomas ir neribojamas. */
    public static class AlwaysVisibleWebView extends WebView {
        public AlwaysVisibleWebView(Context c) { super(c); }
        public AlwaysVisibleWebView(Context c, AttributeSet a) { super(c, a); }
        @Override protected void onWindowVisibilityChanged(int visibility) {
            super.onWindowVisibilityChanged(View.VISIBLE);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;

        web = new AlwaysVisibleWebView(this);
        web.setBackgroundColor(0xFF0B0F14);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setGeolocationEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " VoiceCH311Android/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "Native311");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (baseHost().equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback callback) {
                runOnUiThread(() -> {
                    if (hasLocation()) callback.invoke(origin, true, false);
                    else { pendingGeo = callback; pendingGeoOrigin = origin;
                        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC); }
                });
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (hasMic()) request.grant(request.getResources());
                    else { pendingWebPermission = request; requestPerms(); }
                });
            }
        });

        String url = BuildConfig.BASE_URL;
        Uri link = getIntent() != null ? getIntent().getData() : null;
        if (link != null && baseHost().equals(link.getHost())) url = link.toString();
        web.loadUrl(url);

        requestPerms();
        if (hasMic()) startVoiceService();
    }

    private String baseHost() { return Uri.parse(BuildConfig.BASE_URL).getHost(); }

    private boolean hasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPerms() {
        List<String> need = new ArrayList<>();
        if (!hasMic()) need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOC) {
            if (pendingGeo != null) { pendingGeo.invoke(pendingGeoOrigin, hasLocation(), false); pendingGeo = null; }
            if (hasLocation()) refreshServiceTypes();
            return;
        }
        if (requestCode == REQ_BT) {
            MeshLink m = mesh();
            if (m != null) meshStatus(m.info().toString());
            HudLink hl = hud();
            if (hl != null) { hudStatus(hl.info().toString()); if (hasScanPerm()) hl.scan(); }
            return;
        }
        if (pendingWebPermission != null) {
            if (hasMic()) pendingWebPermission.grant(pendingWebPermission.getResources());
            else pendingWebPermission.deny();
            pendingWebPermission = null;
        }
        if (hasMic()) startVoiceService();
    }

    private void startVoiceService() {
        try {
            Intent i = new Intent(this, VoiceService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Exception ignored) {}
        askBatteryOnce();
    }

    /** Vieną kartą paprašom neriboti baterijos, kad Android neužmigdytų programėlės. */
    @SuppressLint("BatteryLife")
    private void askBatteryOnce() {
        SharedPreferences p = getSharedPreferences("app", MODE_PRIVATE);
        if (p.getBoolean("askedBattery", false)) return;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
            p.edit().putBoolean("askedBattery", true).apply();
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            } catch (Exception ignored) {}
        }
    }

    private void showOffline() {
        String html = "<html><body style='background:#0b0f14;color:#e6edf3;font-family:sans-serif;display:flex;"
                + "flex-direction:column;align-items:center;justify-content:center;height:90vh;text-align:center'>"
                + "<h2><span style='color:#ff8a1f'>311</span> VoiceCH</h2><p style='color:#7d8a99'>Nėra ryšio su serveriu</p>"
                + "<button onclick=\"location.href='" + BuildConfig.BASE_URL + "'\" style='padding:14px 28px;border:0;"
                + "border-radius:12px;background:#ff8a1f;font-size:17px;font-weight:700'>Bandyti dar kartą</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri u = intent.getData();
        if (u != null && baseHost().equals(u.getHost()) && u.getQueryParameter("c") != null) {
            String js = "window.nativeInvite&&nativeInvite(" + jsStr(u.getQueryParameter("c")) + ","
                    + jsStr(u.getQueryParameter("k") == null ? "" : u.getQueryParameter("k")) + ")";
            web.evaluateJavascript(js, null);
        }
    }

    private static String jsStr(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'";
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.nativeBack?nativeBack():false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true); // lieka veikti fone
        });
    }

    // Svarbu: web.onPause() NEkviečiam, kad garsas ir ryšys veiktų užrakinus ekraną.

    @Override
    protected void onDestroy() {
        instance = null;
        stopService(new Intent(this, VoiceService.class));
        if (web != null) { web.destroy(); }
        super.onDestroy();
    }

    /** Kviečiama iš VoiceService (Bluetooth mygtukas): "down" / "up". */
    static void ptt(String mode) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.nativePtt&&nativePtt('" + mode + "')", null));
    }

    /** STOP signalas: rodyti virš užrakinto ekrano ir įjungti ekraną. */
    static void wakeForAlarm() {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 27) { a.setShowWhenLocked(true); a.setTurnScreenOn(true); }
            else a.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            a.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    static void alarmDone() {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 27) { a.setShowWhenLocked(false); a.setTurnScreenOn(false); }
            else a.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            a.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    static void updateStatus(String msg) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.nativeUpdateStatus&&nativeUpdateStatus(" + jsStr(msg) + ")", null));
    }

    // ---------- Meshtastic tiltas ----------
    static void meshStatus(String json) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.nativeMeshStatus&&nativeMeshStatus(" + jsStr(json) + ")", null));
    }

    static void hudStatus(String json) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.nativeHudStatus&&nativeHudStatus(" + jsStr(json) + ")", null));
    }

    static void meshToJs(String raw, boolean alarmHandled) {
        MainActivity a = instance;
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.nativeMesh&&nativeMesh(" + jsStr(raw) + "," + alarmHandled + ")", null));
    }

    private boolean hasBtPerm() {
        return Build.VERSION.SDK_INT < 31
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasScanPerm() {
        return Build.VERSION.SDK_INT < 31
                || (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED && hasBtPerm());
    }

    private HudLink hud() { VoiceService s = VoiceService.inst; return s == null ? null : s.hud; }

    private MeshLink mesh() { VoiceService s = VoiceService.inst; return s == null ? null : s.mesh; }

    class Bridge {
        @JavascriptInterface public void alarm(String text, String from) { VoiceService.alarm(text, from); }
        @JavascriptInterface public void alarmId(String text, String from, String id) {
            VoiceService.alarm(text, from); // dublikatai jau atmesti per markSeen
        }
        @JavascriptInterface public void audioIdle() { VoiceService.audioIdle(); }
        @JavascriptInterface public boolean locationOk() { return hasLocation(); }
        @JavascriptInterface public void requestLocation() {
            runOnUiThread(() -> {
                if (!hasLocation()) requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
                else refreshServiceTypes();
            });
        }
        @JavascriptInterface public void installUpdate(String url) { runOnUiThread(() -> Updater.start(MainActivity.this, url)); }
        /** Iškarpinės tekstas (kviečiama tik paspaudus „Įklijuoti“). */
        @JavascriptInterface public String clipboardText() {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip().getItemCount() == 0) return "";
                CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                return t == null ? "" : t.toString();
            } catch (Exception e) { return ""; }
        }
        /** true, jei id dar nematytas (ir dabar pažymėtas). */
        @JavascriptInterface public boolean markSeen(String id) { VoiceService s = VoiceService.inst; return s == null || s.markSeen(id); }
        @JavascriptInterface public boolean meshSend(String text, String id) { return VoiceService.meshSend(text, id); }
        @JavascriptInterface public String meshInfo() {
            MeshLink m = mesh();
            if (m == null) return "{\"state\":\"no_service\"}";
            try { return m.info().put("perm", hasBtPerm()).toString(); } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public String meshDevices() {
            MeshLink m = mesh();
            if (m == null || !hasBtPerm()) return "null";
            org.json.JSONArray a = m.bondedDevices();
            return a == null ? "null" : a.toString();
        }
        @JavascriptInterface public void meshRequestPerm() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 31 && !hasBtPerm())
                    requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
            });
        }
        @JavascriptInterface public void meshConnect(String address) { MeshLink m = mesh(); if (m != null) runOnUiThread(() -> m.connect(address)); }
        @JavascriptInterface public void meshDisconnect() { MeshLink m = mesh(); if (m != null) runOnUiThread(m::disconnect); }
        @JavascriptInterface public void meshSetChannel(int ch) { MeshLink m = mesh(); if (m != null) runOnUiThread(() -> m.setChannel(ch)); }
        @JavascriptInterface public void openBtSettings() {
            runOnUiThread(() -> { try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); } catch (Exception ignored) {} });
        }
        @JavascriptInterface public void alarmStop() { VoiceService.alarmStop(); }
        // ---- monoklis ----
        @JavascriptInterface public String hudInfo() {
            HudLink hl = hud();
            if (hl == null) return "{\"state\":\"no_service\"}";
            try { return hl.info().put("perm", hasScanPerm()).toString(); } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void hudScan() {
            runOnUiThread(() -> {
                if (!hasScanPerm()) {
                    if (Build.VERSION.SDK_INT >= 31) requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
                    return;
                }
                HudLink hl = hud(); if (hl != null) hl.scan();
            });
        }
        @JavascriptInterface public void hudConnect(String address) { HudLink hl = hud(); if (hl != null) runOnUiThread(() -> hl.connect(address)); }
        @JavascriptInterface public void hudDisconnect() { HudLink hl = hud(); if (hl != null) runOnUiThread(hl::disconnect); }
        @JavascriptInterface public boolean hudSend(String line) { return VoiceService.hudSend(line); }
        @JavascriptInterface public boolean isNative() { return true; }
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public void setStatus(String text) { VoiceService.updateStatus(text); }
        @JavascriptInterface public void exitApp() {
            runOnUiThread(() -> { stopService(new Intent(MainActivity.this, VoiceService.class)); finishAndRemoveTask(); });
        }
    }
}
