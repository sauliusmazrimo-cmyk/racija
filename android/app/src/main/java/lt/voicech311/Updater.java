package lt.voicech311;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import java.io.File;

/** Naujos versijos atsisiuntimas ir diegimo lango atidarymas. */
final class Updater {
    private Updater() {}

    private static long downloadId = -1;
    private static BroadcastReceiver receiver;

    static void start(Activity a, String url) {
        // Android 8+: reikia leidimo diegti programėles iš šios programėlės
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            MainActivity.updateStatus("Leisk 311 VoiceCH diegti atnaujinimus ir spausk „Atnaujinti“ dar kartą");
            try {
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + a.getPackageName())));
            } catch (Exception ignored) {}
            return;
        }
        try {
            File dir = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, "311VoiceCH.apk");
            if (f.exists()) //noinspection ResultOfMethodCallIgnored
                f.delete();

            DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("311 VoiceCH atnaujinimas")
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                    .setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, "311VoiceCH.apk");
            downloadId = dm.enqueue(r);

            if (receiver == null) {
                receiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context c, Intent i) {
                        long id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (id != downloadId) return;
                        install(c, dm, id);
                    }
                };
                IntentFilter flt = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                Context app = a.getApplicationContext();
                if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, flt, Context.RECEIVER_EXPORTED);
                else app.registerReceiver(receiver, flt);
            }
        } catch (Exception e) {
            MainActivity.updateStatus("Nepavyko atsisiųsti: " + e.getMessage());
        }
    }

    private static void install(Context c, DownloadManager dm, long id) {
        try {
            DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
            try (android.database.Cursor cur = dm.query(q)) {
                if (cur == null || !cur.moveToFirst()
                        || cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) != DownloadManager.STATUS_SUCCESSFUL) {
                    MainActivity.updateStatus("Atsisiųsti nepavyko. Patikrink ryšį ir bandyk dar kartą.");
                    return;
                }
            }
            Uri uri = dm.getUriForDownloadedFile(id);
            Intent in = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(in);
        } catch (Exception e) {
            MainActivity.updateStatus("Nepavyko atidaryti diegimo: " + e.getMessage());
        }
    }
}
