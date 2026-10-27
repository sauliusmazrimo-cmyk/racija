package lt.voicech311;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.UUID;

/**
 * Ryšys su Meshtastic mazgu per Bluetooth LE.
 * Siunčia ir gauna tekstines žinutes (STOP signalai, greitos komandos).
 */
@SuppressLint("MissingPermission")
public class MeshLink {

    static final UUID SVC       = UUID.fromString("6ba1b218-15a8-461f-9fa8-5dcae273eafd");
    static final UUID TO_RADIO  = UUID.fromString("f75c76d2-129e-4dad-a1dd-7866124401e7");
    static final UUID FROM_RADIO= UUID.fromString("2c55e69e-4993-11ed-b878-0242ac120002");
    static final UUID FROM_NUM  = UUID.fromString("ed9da18c-a800-4f66-a670-aa7547e34453");
    static final UUID CCCD      = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    public interface Listener {
        void onMeshText(String text, long from);
        void onMeshStatus();
    }

    private final Context ctx;
    private final Listener listener;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final SharedPreferences prefs;
    private final SecureRandom rnd = new SecureRandom();

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic toRadio, fromRadio, fromNum;
    private String address, devName = "";
    private int channel;
    private boolean wanted = false, reading = false;
    private String state = "off"; // off, no_perm, bt_off, connecting, connected, not_meshtastic, disconnected
    private long lastRx = 0;

    // GATT operacijos turi eiti po vieną
    private final ArrayDeque<Runnable> ops = new ArrayDeque<>();
    private boolean busy = false;
    private int opSeq = 0;

    MeshLink(Context c, Listener l) {
        ctx = c.getApplicationContext();
        listener = l;
        prefs = ctx.getSharedPreferences("mesh", Context.MODE_PRIVATE);
        address = prefs.getString("addr", null);
        channel = prefs.getInt("channel", 0);
        if (address != null) { wanted = true; h.postDelayed(this::doConnect, 1500); }
    }

    // ---------- valdymas ----------
    void connect(String addr) {
        address = addr; wanted = true;
        prefs.edit().putString("addr", addr).apply();
        doConnect();
    }

    void disconnect() {
        wanted = false;
        prefs.edit().remove("addr").apply();
        h.removeCallbacks(reconnect);
        closeGatt();
        setState("off");
    }

    /** Paslauga stabdoma: atsijungiam, bet įrenginio adresą prisimenam. */
    void shutdown() {
        wanted = false;
        h.removeCallbacksAndMessages(null);
        closeGatt();
    }

    void setChannel(int ch) {
        channel = Math.max(0, Math.min(7, ch));
        prefs.edit().putInt("channel", channel).apply();
        listener.onMeshStatus();
    }

    boolean isConnected() { return "connected".equals(state); }

    boolean send(String text) {
        if (!isConnected() || toRadio == null) return false;
        final byte[] b = Proto.textPacket(text, channel, rnd.nextInt() & 0x7FFFFFFFL);
        enqueue(() -> writeToRadio(b));
        return true;
    }

    JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state); o.put("name", devName == null ? "" : devName);
            o.put("address", address == null ? "" : address); o.put("channel", channel);
            o.put("lastRx", lastRx);
        } catch (Exception ignored) {}
        return o;
    }

    /** Suporuoti Bluetooth įrenginiai (Meshtastic pirmiau). */
    JSONArray bondedDevices() {
        JSONArray arr = new JSONArray();
        try {
            BluetoothAdapter ad = adapter();
            if (ad == null) return arr;
            for (BluetoothDevice d : ad.getBondedDevices()) {
                if (d.getType() == BluetoothDevice.DEVICE_TYPE_CLASSIC) continue; // tik BLE
                JSONObject o = new JSONObject();
                String n = d.getName() == null ? d.getAddress() : d.getName();
                o.put("name", n); o.put("address", d.getAddress());
                o.put("mesh", n.toLowerCase().contains("meshtastic") || n.matches(".*_[0-9a-fA-F]{4}$"));
                arr.put(o);
            }
        } catch (SecurityException e) {
            return null; // nėra leidimo
        } catch (Exception ignored) {}
        return arr;
    }

    // ---------- prisijungimas ----------
    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    private final Runnable reconnect = this::doConnect;

    private void scheduleReconnect() {
        h.removeCallbacks(reconnect);
        if (wanted) h.postDelayed(reconnect, 8000);
    }

    private void doConnect() {
        h.removeCallbacks(reconnect);
        if (!wanted || address == null) return;
        closeGatt();
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled()) { setState("bt_off"); scheduleReconnect(); return; }
        try {
            BluetoothDevice d = ad.getRemoteDevice(address);
            devName = d.getName();
            setState("connecting");
            gatt = d.connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            setState("no_perm");
        } catch (Exception e) {
            setState("disconnected"); scheduleReconnect();
        }
    }

    private void closeGatt() {
        ops.clear(); busy = false; reading = false;
        toRadio = fromRadio = fromNum = null;
        if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) {} gatt = null; }
    }

    private void setState(String s) {
        if (s.equals(state)) return;
        state = s;
        listener.onMeshStatus();
    }

    // ---------- operacijų eilė ----------
    private void enqueue(Runnable r) {
        h.post(() -> { ops.add(r); if (!busy) nextOp(); });
    }

    private void nextOp() {
        Runnable r = ops.poll();
        if (r == null) { busy = false; return; }
        busy = true;
        final int seq = ++opSeq;
        h.postDelayed(() -> { if (busy && seq == opSeq) { busy = false; nextOp(); } }, 6000); // apsauga nuo užstrigimo
        try { r.run(); } catch (Exception e) { opDone(); }
    }

    private void opDone() { h.post(() -> { busy = false; nextOp(); }); }

    @SuppressWarnings("deprecation")
    private void writeToRadio(byte[] b) {
        if (gatt == null || toRadio == null) { opDone(); return; }
        toRadio.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        toRadio.setValue(b);
        if (!gatt.writeCharacteristic(toRadio)) opDone();
    }

    private void readFromRadio() {
        if (gatt == null || fromRadio == null) { reading = false; opDone(); return; }
        if (!gatt.readCharacteristic(fromRadio)) { reading = false; opDone(); }
    }

    private void startReading() {
        if (reading) return;
        reading = true;
        enqueue(this::readFromRadio);
    }

    private void handleFromRadio(byte[] v) {
        Proto.Text t = Proto.textFromRadio(v);
        if (t == null) return;
        // senos (eilėje užsilikusios) žinutės ignoruojamos, jei mazgo laikas patikimas
        long now = System.currentTimeMillis() / 1000;
        if (t.rxTime > 1_600_000_000L && now - t.rxTime > 180) return;
        if (t.channel != channel) return;
        lastRx = System.currentTimeMillis();
        listener.onMeshText(t.text, t.from);
    }

    // ---------- GATT atsakymai ----------
    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            h.post(() -> {
                if (g != gatt) return;
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    ops.clear(); busy = false;
                    enqueue(() -> { if (!g.requestMtu(512)) opDone(); });
                    enqueue(() -> { if (!g.discoverServices()) opDone(); });
                } else {
                    closeGatt();
                    setState("disconnected");
                    scheduleReconnect();
                }
            });
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) { opDone(); }

        @Override
        @SuppressWarnings("deprecation")
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            h.post(() -> {
                BluetoothGattService s = g.getService(SVC);
                if (s == null) { setState("not_meshtastic"); wanted = false; closeGatt(); opDone(); return; }
                toRadio = s.getCharacteristic(TO_RADIO);
                fromRadio = s.getCharacteristic(FROM_RADIO);
                fromNum = s.getCharacteristic(FROM_NUM);
                opDone();
                if (fromNum != null) {
                    g.setCharacteristicNotification(fromNum, true);
                    final BluetoothGattDescriptor d = fromNum.getDescriptor(CCCD);
                    if (d != null) enqueue(() -> {
                        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        if (!g.writeDescriptor(d)) opDone();
                    });
                }
                final byte[] cfg = Proto.wantConfig(rnd.nextInt() & 0x7FFFFFFFL);
                enqueue(() -> writeToRadio(cfg));
                startReading();
                setState("connected");
            });
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { opDone(); }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) { opDone(); }

        // Android 13+
        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            onRead(c, value, status);
        }
        // senesni Android
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            onRead(c, c.getValue(), status);
        }

        private void onRead(BluetoothGattCharacteristic c, byte[] value, int status) {
            final byte[] v = value == null ? new byte[0] : value.clone();
            h.post(() -> {
                busy = false;
                if (FROM_RADIO.equals(c.getUuid())) {
                    if (status == BluetoothGatt.GATT_SUCCESS && v.length > 0) {
                        try { handleFromRadio(v); } catch (Exception ignored) {}
                        ops.addFirst(MeshLink.this::readFromRadio); // skaitom toliau, kol tuščia
                    } else {
                        reading = false;
                    }
                }
                nextOp();
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            if (FROM_NUM.equals(c.getUuid())) h.post(MeshLink.this::startReading);
        }
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (FROM_NUM.equals(c.getUuid())) h.post(MeshLink.this::startReading);
        }
    };
}
