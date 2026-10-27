package lt.voicech311;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.view.KeyEvent;

/** Gauna medijos mygtukus, kai MediaSession neaktyvi, ir perduoda paslaugai. */
public class MediaButtonReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction())) return;
        KeyEvent ke = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        VoiceService s = VoiceService.inst;
        if (s != null) s.handleKey(ke);
    }
}
