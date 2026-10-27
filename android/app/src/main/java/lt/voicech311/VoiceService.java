package lt.voicech311;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.KeyEvent;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foninė paslauga: laiko programėlę gyvą užrakinus ekraną (mikrofonas + garsas),
 * rodo pastovų pranešimą ir priima Bluetooth / ausinių mygtukus kaip PTT.
 */
public class VoiceService extends Service {

    static final String CH = "voice";
    static final String ACTION_STOP = "lt.voicech311.STOP";
    static VoiceService inst;
    private static String status = "Paruošta";

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    // PTT mygtuko būsena: trumpas paspaudimas = įjungti/išjungti, laikymas = kalbėti kol laikai
    private boolean toggled = false, ignoreUp = false;
    private long downAt = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, "311 VoiceCH ryšys", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        NotificationChannel al = new NotificationChannel(CH_ALARM, "STOP signalai", NotificationManager.IMPORTANCE_HIGH);
        al.setBypassDnd(true);
        al.setSound(null, null); // garsą groja ToneGenerator per žadintuvo srautą
        al.enableVibration(false);
        al.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(al);

        Notification n = build();
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else if (Build.VERSION.SDK_INT == 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(1, n);
        }

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VoiceCH311:ryšys");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "VoiceCH311:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
        setupMediaSession();
        NotificationChannel cc = new NotificationChannel(CH_CMD, "Greitos komandos (LoRa)", NotificationManager.IMPORTANCE_HIGH);
        cc.enableVibration(true);
        nm.createNotificationChannel(cc);
        mesh = new MeshLink(this, new MeshLink.Listener() {
            @Override public void onMeshText(String text, long from) { handleMeshText(text); }
            @Override public void onMeshStatus() { MainActivity.meshStatus(mesh.info().toString()); }
        });
    }

    // ---------- Meshtastic (LoRa) ----------
    static final String CH_CMD = "cmd";
    MeshLink mesh;
    private static final Pattern MSG = Pattern.compile("^(🚨|📢)\\s*(.+?)\\s+·\\s+(.+?)\\s+#([0-9a-z]{6})$");
    private static final int MIN_MOD = 36 * 36 * 36 * 36;
    private final Map<String, Boolean> seen = new LinkedHashMap<String, Boolean>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > 200; }
    };

    /** true, jei id naujas (dar nematytas). */
    synchronized boolean markSeen(String id) {
        if (id == null || id.isEmpty()) return true;
        if (seen.containsKey(id)) return false;
        seen.put(id, true);
        return true;
    }

    private static boolean stale(String id) {
        try {
            int minute = Integer.parseInt(id.substring(0, 4), 36);
            int now = (int) ((System.currentTimeMillis() / 60000L) % MIN_MOD);
            int diff = ((now - minute) % MIN_MOD + MIN_MOD) % MIN_MOD;
            return diff > 3 && diff < MIN_MOD - 3;
        } catch (Exception e) { return false; }
    }

    private void handleMeshText(String raw) {
        String text = raw.trim();
        boolean alarm; String cmd, who, id = null;
        Matcher m = MSG.matcher(text);
        if (m.matches()) {
            alarm = m.group(1).equals("🚨"); cmd = m.group(2); who = m.group(3); id = m.group(4);
            if (stale(id)) return;
        } else if (text.startsWith("🚨") || text.startsWith("📢")) {
            alarm = text.startsWith("🚨"); cmd = text.substring(2).trim(); who = "LoRa";
        } else {
            return; // kitos Meshtastic žinutės mūsų neliečia
        }
        if (!markSeen(id)) return;
        if (alarm) doAlarm(cmd, who + " · LoRa");
        else cmdNotify(cmd, who);
        MainActivity.meshToJs(text, alarm);
    }

    private void cmdNotify(String cmd, String who) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 3, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_CMD)
                .setSmallIcon(R.drawable.ic_mic)
                .setContentTitle("📢 " + cmd)
                .setContentText(who + " · LoRa")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(3, n);
    }

    static boolean meshSend(String text, String id) {
        VoiceService s = inst;
        if (s == null || s.mesh == null) return false;
        s.markSeen(id);
        return s.mesh.send(text);
    }

    @SuppressWarnings("deprecation")
    private void setupMediaSession() {
        session = new MediaSession(this, "VoiceCH311");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override
            public boolean onMediaButtonEvent(Intent intent) {
                KeyEvent ke = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                return handleKey(ke) || super.onMediaButtonEvent(intent);
            }
        });
        Intent mb = new Intent(Intent.ACTION_MEDIA_BUTTON);
        mb.setComponent(new ComponentName(this, MediaButtonReceiver.class));
        session.setMediaButtonReceiver(PendingIntent.getBroadcast(this, 0, mb, PendingIntent.FLAG_IMMUTABLE));
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build());
        session.setActive(true);
    }

    /** true, jei mygtukas apdorotas kaip PTT. */
    boolean handleKey(KeyEvent ke) {
        if (ke == null) return false;
        int c = ke.getKeyCode();
        boolean ptt = c == KeyEvent.KEYCODE_HEADSETHOOK || c == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || c == KeyEvent.KEYCODE_MEDIA_PLAY || c == KeyEvent.KEYCODE_MEDIA_PAUSE
                || c == KeyEvent.KEYCODE_MEDIA_NEXT || c == KeyEvent.KEYCODE_MEDIA_PREVIOUS;
        if (!ptt) return false;
        long now = SystemClock.uptimeMillis();
        if (ke.getAction() == KeyEvent.ACTION_DOWN && ke.getRepeatCount() == 0) {
            if (toggled) { toggled = false; ignoreUp = true; MainActivity.ptt("up"); }
            else { downAt = now; MainActivity.ptt("down"); }
        } else if (ke.getAction() == KeyEvent.ACTION_UP) {
            if (ignoreUp) { ignoreUp = false; return true; }
            if (now - downAt < 600) toggled = true;   // trumpas paspaudimas: kalbama iki kito paspaudimo
            else MainActivity.ptt("up");              // laikytas: baigiam atleidus
        }
        return true;
    }

    private Notification build() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, VoiceService.class).setAction(ACTION_STOP);
        PendingIntent ps = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH)
                .setSmallIcon(R.drawable.ic_mic)
                .setContentTitle("311 VoiceCH")
                .setContentText(status)
                .setContentIntent(pi)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_CALL)
                .addAction(new Notification.Action.Builder(null, "Išjungti", ps).build())
                .build();
    }

    // ---------- STOP signalas ----------
    static final String CH_ALARM = "alarm";
    private ToneGenerator tone;
    private int prevAlarmVol = -1;
    private final Handler handler = new Handler(Looper.getMainLooper());

    static void alarm(String text, String from) {
        VoiceService s = inst;
        if (s != null) s.handler.post(() -> s.doAlarm(text, from));
    }
    static void alarmStop() {
        VoiceService s = inst;
        if (s != null) s.handler.post(s::stopAlarm);
    }

    @SuppressWarnings("deprecation")
    private void doAlarm(String text, String from) {
        stopAlarm();
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        try {
            prevAlarmVol = am.getStreamVolume(AudioManager.STREAM_ALARM);
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        } catch (Exception ignored) { prevAlarmVol = -1; }
        try {
            tone = new ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME);
            tone.startTone(ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK, 4000);
        } catch (Exception ignored) {}
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            long[] pattern = {0, 600, 200, 600, 200, 600, 200, 1200};
            AudioAttributes aa = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build();
            v.vibrate(VibrationEffect.createWaveform(pattern, -1), aa);
        } catch (Exception ignored) {}

        // pranešimas, kuris pažadina ekraną ir atidaro programėlę
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("alarm", true);
        PendingIntent pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_ALARM)
                .setSmallIcon(R.drawable.ic_mic)
                .setContentTitle("🚨 " + text)
                .setContentText(from)
                .setCategory(Notification.CATEGORY_ALARM)
                .setContentIntent(pi)
                .setFullScreenIntent(pi, true)
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(2, n);
        MainActivity.wakeForAlarm();
        handler.postDelayed(this::releaseTone, 4500);
    }

    private void releaseTone() {
        if (tone != null) { try { tone.stopTone(); tone.release(); } catch (Exception ignored) {} tone = null; }
        if (prevAlarmVol >= 0) {
            try { ((AudioManager) getSystemService(AUDIO_SERVICE)).setStreamVolume(AudioManager.STREAM_ALARM, prevAlarmVol, 0); } catch (Exception ignored) {}
            prevAlarmVol = -1;
        }
    }

    private void stopAlarm() {
        handler.removeCallbacksAndMessages(null);
        releaseTone();
        try { ((Vibrator) getSystemService(VIBRATOR_SERVICE)).cancel(); } catch (Exception ignored) {}
        getSystemService(NotificationManager.class).cancel(2);
        MainActivity.alarmDone();
    }

    static void updateStatus(String text) {
        if (text == null || text.equals(status)) return;
        status = text;
        VoiceService s = inst;
        if (s != null) s.getSystemService(NotificationManager.class).notify(1, s.build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            MainActivity a = MainActivity.instance;
            if (a != null) a.runOnUiThread(a::finishAndRemoveTask);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        inst = null;
        handler.removeCallbacksAndMessages(null);
        releaseTone();
        if (mesh != null) mesh.shutdown();
        if (session != null) session.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
