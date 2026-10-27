// Racija MVP – push-to-talk serveris
// Balsas: 16 kHz, G.711 mu-law (1 baitas/mėginys), siunčiamas realiu laiku per WebSocket.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const RATE = 16000;
const MAX_TALK_MS = 60000;   // ilgiausia viena žinutė
const HISTORY_LIMIT = 50;    // kiek žinučių laikyti kanale
const MIN_BYTES = RATE * 0.3; // trumpesnių nei 0,3 s nesaugom

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- mu-law dekodavimas (WAV įrašams) ----
const MU = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  MU[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

function muToWav(mu) {
  const dataLen = mu.length * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < mu.length; i++) b.writeInt16LE(MU[mu[i]], 44 + i * 2);
  return b;
}

// ---- kanalai ----
const channels = new Map();
let seq = 0;

function getChannel(name) {
  if (!channels.has(name)) channels.set(name, { clients: new Set(), talker: null, current: null, timer: null, history: [] });
  return channels.get(name);
}

const meta = (h) => ({ id: h.id, from: h.from, ts: h.ts, dur: h.dur });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(c, obj, except) {
  const s = JSON.stringify(obj);
  for (const w of c.clients) if (w !== except && w.readyState === 1) w.send(s);
}
function presence(c) {
  broadcast(c, {
    t: 'presence',
    users: [...c.clients].map(w => w.user.name),
    talker: c.talker ? c.talker.user.name : null
  });
}

function endTalk(ws, forced = false) {
  const c = ws.chan;
  if (!c || c.talker !== ws) return;
  clearTimeout(c.timer);
  const cur = c.current;
  const data = Buffer.concat(cur.chunks);
  c.talker = null; c.current = null;
  let item = null;
  if (data.length >= MIN_BYTES) {
    item = { id: cur.id, from: cur.from, ts: cur.ts, dur: +(data.length / RATE).toFixed(1), data };
    c.history.push(item);
    if (c.history.length > HISTORY_LIMIT) c.history.shift();
  }
  broadcast(c, { t: 'stop', id: cur.id, from: cur.from, forced, item: item ? meta(item) : null });
  presence(c);
}

function leave(ws) {
  if (!ws.chan) return;
  endTalk(ws);
  const c = ws.chan;
  c.clients.delete(ws);
  ws.chan = null;
  presence(c);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const c = ws.chan;
      if (!c || c.talker !== ws) return;
      c.current.chunks.push(Buffer.from(data));
      for (const w of c.clients) if (w !== ws && w.readyState === 1) w.send(data, { binary: true });
      return;
    }
    let m; try { m = JSON.parse(data); } catch { return; }

    if (m.t === 'join') {
      leave(ws);
      const name = String(m.name || '').trim().slice(0, 32) || 'Be vardo';
      const chan = String(m.channel || '').trim().toLowerCase().slice(0, 32) || 'bendras';
      ws.user = { name };
      ws.chan = getChannel(chan);
      ws.chan.clients.add(ws);
      send(ws, { t: 'joined', channel: chan, history: ws.chan.history.map(meta) });
      presence(ws.chan);
    } else if (m.t === 'start') {
      const c = ws.chan;
      if (!c) return;
      if (c.talker && c.talker !== ws) return send(ws, { t: 'busy', by: c.talker.user.name });
      c.talker = ws;
      c.current = { id: ++seq, from: ws.user.name, ts: Date.now(), chunks: [] };
      c.timer = setTimeout(() => endTalk(ws, true), MAX_TALK_MS);
      send(ws, { t: 'granted', id: c.current.id });
      broadcast(c, { t: 'start', from: ws.user.name, id: c.current.id }, ws);
      presence(c);
    } else if (m.t === 'stop') {
      endTalk(ws);
    }
  });

  ws.on('close', () => leave(ws));
});

// pasimetusių ryšių valymas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// įrašų atkūrimas
app.get('/audio/:id', (req, res) => {
  const id = Number(req.params.id);
  for (const c of channels.values()) {
    const h = c.history.find(x => x.id === id);
    if (h) {
      res.set('Content-Type', 'audio/wav');
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(muToWav(h.data));
    }
  }
  res.status(404).send('Nerasta');
});

app.get('/health', (_, res) => res.json({ ok: true, channels: channels.size, clients: wss.clients.size }));

server.listen(PORT, () => console.log(`Racija veikia: http://localhost:${PORT}`));
