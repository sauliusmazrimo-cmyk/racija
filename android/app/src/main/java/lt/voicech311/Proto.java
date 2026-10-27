package lt.voicech311;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Minimalus protobuf kodavimas Meshtastic žinutėms (be papildomų bibliotekų).
 * Laukų numeriai pagal meshtastic/protobufs mesh.proto.
 */
public final class Proto {
    private Proto() {}

    public static final int PORT_TEXT = 1;          // PortNum.TEXT_MESSAGE_APP
    public static final long BROADCAST = 0xFFFFFFFFL;

    // ---------- kodavimas ----------
    static void varint(ByteArrayOutputStream o, long v) {
        while ((v & ~0x7FL) != 0) { o.write((int) ((v & 0x7F) | 0x80)); v >>>= 7; }
        o.write((int) v);
    }
    static void tag(ByteArrayOutputStream o, int field, int wire) { varint(o, ((long) field << 3) | wire); }
    static void fVarint(ByteArrayOutputStream o, int field, long v) { tag(o, field, 0); varint(o, v); }
    static void fFixed32(ByteArrayOutputStream o, int field, long v) {
        tag(o, field, 5);
        for (int i = 0; i < 4; i++) o.write((int) ((v >>> (8 * i)) & 0xFF));
    }
    static void fBytes(ByteArrayOutputStream o, int field, byte[] b) {
        tag(o, field, 2); varint(o, b.length); o.write(b, 0, b.length);
    }

    /** ToRadio { want_config_id = 3 } */
    public static byte[] wantConfig(long id) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        fVarint(o, 3, id & 0xFFFFFFFFL);
        return o.toByteArray();
    }

    /** ToRadio { packet = 1: MeshPacket { to=2, channel=3, decoded=4: Data{portnum=1, payload=2}, id=6, want_ack=10 } } */
    public static byte[] textPacket(String text, int channel, long packetId) {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        fVarint(data, 1, PORT_TEXT);
        fBytes(data, 2, text.getBytes(StandardCharsets.UTF_8));

        ByteArrayOutputStream pkt = new ByteArrayOutputStream();
        fFixed32(pkt, 2, BROADCAST);
        if (channel > 0) fVarint(pkt, 3, channel);
        fBytes(pkt, 4, data.toByteArray());
        fFixed32(pkt, 6, packetId & 0xFFFFFFFFL);
        fVarint(pkt, 10, 1);

        ByteArrayOutputStream to = new ByteArrayOutputStream();
        fBytes(to, 1, pkt.toByteArray());
        return to.toByteArray();
    }

    // ---------- skaitymas ----------
    public static final class Field {
        public final int num, wire; public final long v; public final byte[] b;
        Field(int num, int wire, long v, byte[] b) { this.num = num; this.wire = wire; this.v = v; this.b = b; }
    }

    public static List<Field> parse(byte[] buf) {
        List<Field> out = new ArrayList<>();
        int[] p = {0};
        try {
            while (p[0] < buf.length) {
                long key = readVarint(buf, p);
                int num = (int) (key >>> 3), wire = (int) (key & 7);
                switch (wire) {
                    case 0: out.add(new Field(num, 0, readVarint(buf, p), null)); break;
                    case 1: { long v = 0; for (int i = 0; i < 8; i++) v |= (buf[p[0] + i] & 0xFFL) << (8 * i); p[0] += 8; out.add(new Field(num, 1, v, null)); break; }
                    case 2: { int len = (int) readVarint(buf, p); byte[] b = new byte[len]; System.arraycopy(buf, p[0], b, 0, len); p[0] += len; out.add(new Field(num, 2, 0, b)); break; }
                    case 5: { long v = 0; for (int i = 0; i < 4; i++) v |= (buf[p[0] + i] & 0xFFL) << (8 * i); p[0] += 4; out.add(new Field(num, 5, v, null)); break; }
                    default: return out; // nežinomas tipas: stabdom
                }
            }
        } catch (RuntimeException e) { /* sugadintas paketas */ }
        return out;
    }

    static long readVarint(byte[] b, int[] p) {
        long r = 0; int shift = 0;
        while (true) {
            int x = b[p[0]++] & 0xFF;
            r |= (long) (x & 0x7F) << shift;
            if ((x & 0x80) == 0) return r;
            shift += 7;
            if (shift > 63) throw new RuntimeException("varint");
        }
    }

    static Field first(List<Field> fs, int num) { for (Field f : fs) if (f.num == num) return f; return null; }

    /** Gautas tekstas iš FromRadio arba null. */
    public static final class Text {
        public final String text; public final long from; public final int channel; public final long rxTime;
        Text(String t, long f, int c, long r) { text = t; from = f; channel = c; rxTime = r; }
    }

    /** FromRadio { packet = 2: MeshPacket { from=1, channel=3, decoded=4, rx_time=7 } } */
    public static Text textFromRadio(byte[] fromRadio) {
        Field pf = first(parse(fromRadio), 2);
        if (pf == null || pf.b == null) return null;
        List<Field> pkt = parse(pf.b);
        Field dec = first(pkt, 4);
        if (dec == null || dec.b == null) return null;
        List<Field> data = parse(dec.b);
        Field port = first(data, 1), payload = first(data, 2);
        if (port == null || port.v != PORT_TEXT || payload == null || payload.b == null) return null;
        Field from = first(pkt, 1), ch = first(pkt, 3), rx = first(pkt, 7);
        return new Text(new String(payload.b, StandardCharsets.UTF_8),
                from == null ? 0 : from.v, ch == null ? 0 : (int) ch.v, rx == null ? 0 : rx.v);
    }
}
