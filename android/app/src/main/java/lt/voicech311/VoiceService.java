package lt.voicech311;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.KeyEvent;

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
        if (session != null) session.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
