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
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Ryšys su 311 VoiceCH monokliu (XIAO ESP32C3) per Bluetooth LE.
 * Siunčiamos tekstinės eilutės (N|..., M|..., A|..., X, T|..., K|..., L|..., F|...).
 */
@SuppressLint("MissingPermission")
public class HudLink {

    static final UUID SVC  = UUID.fromString("7a1e0001-3110-4c48-9f0b-6d6f6e6f6b6c");
    static final UUID RX   = UUID.fromString("7a1e0002-3110-4c48-9f0b-6d6f6e6f6b6c");
    static final UUID TX   = UUID.fromString("7a1e0003-3110-4c48-9f0b-6d6f6e6f6b6c");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    public interface Listener { void onHudStatus(); default void onHudButton(boolean down) {} }

    private final Context ctx;
    private final Listener listener;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final SharedPreferences prefs;

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic rx, tx;
    private String address, devName = "";
    private boolean wanted = false;
    private String state = "off"; // off, no_perm, bt_off, connecting, connected, not_hud, disconnected
    private String lastStatus = "";
    private long lastStatusAt = 0;

    // paieška
    private boolean scanning = false;
    private final Map<String, String> found = Collections.synchronizedMap(new LinkedHashMap<>());

    // rašymų eilė (vienu metu viena GATT operacija); N eilutės nesikaupia – lieka tik naujausia
    private final ArrayDeque<String> out = new ArrayDeque<>();
    private boolean busy = false;
    private int opSeq = 0;
    private boolean cccdPending = false;

    HudLink(Context c, Listener l) {
        ctx = c.getApplicationContext();
        listener = l;
        prefs = ctx.getSharedPreferences("hud", Context.MODE_PRIVATE);
        address = prefs.getString("addr", null);
        devName = prefs.getString("name", "");
        if (address != null) { wanted = true; h.postDelayed(this::doConnect, 2000); }
    }

    // ---------- valdymas ----------
    void connect(String addr) {
        stopScan();
        address = addr; wanted = true;
        String n = found.get(addr);
        devName = n == null ? "" : n;
        prefs.edit().putString("addr", addr).putString("name", devName).apply();
        doConnect();
    }

    void disconnect() {
        wanted = false;
        prefs.edit().remove("addr").remove("name").apply();
        h.removeCallbacks(reconnect);
        closeGatt();
        setState("off");
    }

    void shutdown() {
        wanted = false;
        stopScan();
        h.removeCallbacksAndMessages(null);
        closeGatt();
    }

    boolean isConnected() { return "connected".equals(state); }

    /** Įdeda eilutę į siuntimo eilę. */
    boolean send(String line) {
        if (!isConnected() || rx == null || line == null) return false;
        final String l = line.length() > 180 ? line.substring(0, 180) : line;
        h.post(() -> {
            if (l.startsWith("N|")) out.removeIf(s -> s.startsWith("N|"));
            if (out.size() > 20) out.pollFirst();
            out.add(l);
            if (!busy) next();
        });
        return true;
    }

    JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state); o.put("name", devName == null ? "" : devName);
            o.put("address", address == null ? "" : address);
            o.put("scanning", scanning);
            o.put("status", System.currentTimeMillis() - lastStatusAt < 10000 ? lastStatus : "");
            JSONArray a = new JSONArray();
            synchronized (found) {
                for (Map.Entry<String, String> e : found.entrySet()) {
                    JSONObject d = new JSONObject(); d.put("address", e.getKey()); d.put("name", e.getValue()); a.put(d);
                }
            }
            o.put("found", a);
        } catch (Exception ignored) {}
        return o;
    }

    // ---------- paieška ----------
    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    private final ScanCallback scanCb = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult r) {
            BluetoothDevice d = r.getDevice();
            String n = null;
            if (r.getScanRecord() != null) n = r.getScanRecord().getDeviceName();
            if (n == null) try { n = d.getName(); } catch (SecurityException ignored) {}
            if (n == null) n = "311-Monoklis";
            boolean isNew = !found.containsKey(d.getAddress());
            found.put(d.getAddress(), n);
            if (isNew) h.post(listener::onHudStatus);
        }
        @Override public void onScanFailed(int code) { scanning = false; h.post(listener::onHudStatus); }
    };

    void scan() {
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled()) { setState("bt_off"); return; }
        try {
            BluetoothLeScanner sc = ad.getBluetoothLeScanner();
            if (sc == null) return;
            if (scanning) sc.stopScan(scanCb);
            found.clear();
            ScanFilter f = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SVC)).build();
            ScanSettings s = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            sc.startScan(Collections.singletonList(f), s, scanCb);
            scanning = true;
            listener.onHudStatus();
            h.postDelayed(this::stopScan, 12000);
        } catch (SecurityException e) {
            setState("no_perm");
        } catch (Exception ignored) {}
    }

    void stopScan() {
        if (!scanning) return;
        scanning = false;
        try { BluetoothAdapter ad = adapter(); if (ad != null && ad.getBluetoothLeScanner() != null) ad.getBluetoothLeScanner().stopScan(scanCb); }
        catch (Exception ignored) {}
        listener.onHudStatus();
    }

    // ---------- prisijungimas ----------
    private final Runnable reconnect = this::doConnect;

    private void scheduleReconnect() {
        h.removeCallbacks(reconnect);
        if (wanted) h.postDelayed(reconnect, 6000);
    }

    private void doConnect() {
        h.removeCallbacks(reconnect);
        if (!wanted || address == null) return;
        closeGatt();
        BluetoothAdapter ad = adapter();
        if (ad == null || !ad.isEnabled()) { setState("bt_off"); scheduleReconnect(); return; }
        try {
            BluetoothDevice d = ad.getRemoteDevice(address);
            setState("connecting");
            gatt = d.connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            setState("no_perm");
        } catch (Exception e) {
            setState("disconnected"); scheduleReconnect();
        }
    }

    private void closeGatt() {
        out.clear(); busy = false; cccdPending = false;
        rx = tx = null;
        if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) {} gatt = null; }
    }

    private void setState(String s) {
        if (s.equals(state)) return;
        state = s;
        listener.onHudStatus();
    }

    // ---------- rašymas ----------
    @SuppressWarnings("deprecation")
    private void next() {
        if (gatt == null || rx == null) { busy = false; return; }
        String l = out.pollFirst();
        if (l == null) { busy = false; return; }
        busy = true;
        final int seq = ++opSeq;
        h.postDelayed(() -> { if (busy && seq == opSeq) { busy = false; next(); } }, 3000);
        try {
            rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            rx.setValue(l.getBytes(StandardCharsets.UTF_8));
            if (!gatt.writeCharacteristic(rx)) { busy = false; h.postDelayed(this::next, 100); }
        } catch (Exception e) { busy = false; }
    }

    // ---------- GATT atsakymai ----------
    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            h.post(() -> {
                if (g != gatt) return;
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!g.requestMtu(247)) g.discoverServices();
                } else {
                    closeGatt();
                    setState("disconnected");
                    scheduleReconnect();
                }
            });
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) { h.post(() -> { if (g == gatt) g.discoverServices(); }); }

        @Override
        @SuppressWarnings("deprecation")
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            h.post(() -> {
                if (g != gatt) return;
                BluetoothGattService s = g.getService(SVC);
                if (s == null) { setState("not_hud"); wanted = false; closeGatt(); return; }
                rx = s.getCharacteristic(RX);
                tx = s.getCharacteristic(TX);
                if (tx != null) {
                    g.setCharacteristicNotification(tx, true);
                    BluetoothGattDescriptor d = tx.getDescriptor(CCCD);
                    if (d != null) {
                        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        cccdPending = g.writeDescriptor(d);
                    }
                }
                try {
                    BluetoothDevice dev = g.getDevice();
                    if (dev.getName() != null) { devName = dev.getName(); prefs.edit().putString("name", devName).apply(); }
                } catch (SecurityException ignored) {}
                setState("connected");
                if (!cccdPending) next();
            });
        }

        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            h.post(() -> { cccdPending = false; if (!busy) next(); });
        }

        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            h.post(() -> { busy = false; next(); });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) { onStatus(value); }
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) { onStatus(c.getValue()); }

        private void onStatus(byte[] v) {
            if (v == null) return;
            final String s = new String(v, StandardCharsets.UTF_8);
            if (s.startsWith("B|")) { final boolean down = s.startsWith("B|1"); h.post(() -> listener.onHudButton(down)); return; }
            h.post(() -> {
                boolean changed = !s.equals(lastStatus);
                lastStatus = s; lastStatusAt = System.currentTimeMillis();
                if (changed) listener.onHudStatus();
            });
        }
    };
}
