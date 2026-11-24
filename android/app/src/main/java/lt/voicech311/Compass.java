package lt.voicech311;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.view.Surface;
import android.view.WindowManager;

/**
 * Telefono kompasas iš ROTATION_VECTOR jutiklio (magnetometras + giroskopas + akselerometras):
 * greitas ir stabilus. Kryptis perduodama į puslapį ~30 kartų per sekundę.
 */
public class Compass implements SensorEventListener {
    public interface Out { void heading(float deg, int accuracy); }

    private final SensorManager sm;
    private final WindowManager wm;
    private final Sensor rv;
    private final Out out;
    private boolean on = false;
    private long last = 0;
    private int acc = SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM;
    private final float[] R = new float[9], R2 = new float[9], O = new float[3];

    Compass(Context c, Out o) {
        sm = (SensorManager) c.getSystemService(Context.SENSOR_SERVICE);
        wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
        Sensor s = sm == null ? null : sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        rv = s;
        out = o;
    }

    boolean available() { return rv != null; }

    void start() {
        if (on || rv == null) return;
        on = sm.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
    }

    void stop() {
        if (!on) return;
        sm.unregisterListener(this);
        on = false;
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        long now = System.currentTimeMillis();
        if (now - last < 33) return;
        last = now;
        SensorManager.getRotationMatrixFromVector(R, e.values);
        // ekrano pasukimas (gulsčias / stačias)
        int rot = wm == null ? Surface.ROTATION_0 : wm.getDefaultDisplay().getRotation();
        float[] M = R;
        if (rot == Surface.ROTATION_90) { SensorManager.remapCoordinateSystem(R, SensorManager.AXIS_Y, SensorManager.AXIS_MINUS_X, R2); M = R2; }
        else if (rot == Surface.ROTATION_180) { SensorManager.remapCoordinateSystem(R, SensorManager.AXIS_MINUS_X, SensorManager.AXIS_MINUS_Y, R2); M = R2; }
        else if (rot == Surface.ROTATION_270) { SensorManager.remapCoordinateSystem(R, SensorManager.AXIS_MINUS_Y, SensorManager.AXIS_X, R2); M = R2; }
        SensorManager.getOrientation(M, O);
        // telefonas laikomas stačiai (žiūri pro jį) – kryptis pagal galinę kamerą
        if (Math.abs(O[1]) > Math.toRadians(55)) {
            float[] R3 = new float[9];
            SensorManager.remapCoordinateSystem(M, SensorManager.AXIS_X, SensorManager.AXIS_Z, R3);
            SensorManager.getOrientation(R3, O);
        }
        float deg = (float) ((Math.toDegrees(O[0]) + 360) % 360);
        out.heading(deg, acc);
    }

    @Override
    public void onAccuracyChanged(Sensor s, int a) { acc = a; }
}
