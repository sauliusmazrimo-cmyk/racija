// Racija v0.2 – push-to-talk serveris
// Balsas: 16 kHz, G.711 mu-law (1 baitas/mėginys), realiu laiku per WebSocket.
// Kanalai su slaptažodžiais, savininku, istorija diske.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const RATE = 16000;
const MAX_TALK_MS = 60000;
const HISTORY_LIMIT = 50;
const MIN_BYTES = RATE * 0.3;

// Railway Volume prijungus, kelias atsiranda automatiškai
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------- duomenų bazė (JSON failas) ----------
let db = { seq: 0, channels: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
db.channels = db.channels || {};
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (e) => { if (!e) fs.rename(tmp, DB_FILE, () => {}); });
  }, 300);
}
function flushDb() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.error(e); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushDb(); process.exit(0); });
const audioFile =(id) => path.join(AUDIO_DIR, `${id}.ulaw`);
const rmAudio = (id) => fs.unlink(audioFile(id), () => {});

// ---------- saugumas ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function checkPw(pw, ch) {
  const a = Buffer.from(hashPw(pw, ch.salt), 'hex'), b = Buffer.from(ch.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normChannel(s) {
  const n = String(s || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
  return /^[\p{L}\p{N}_-]{2,32}$/u.test(n) ? n : null;
}

// ---------- mu-law -> WAV ----------
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

// ---------- gyvi kanalai ----------
const live = new Map(); // vardas -> { clients, talker, current, timer }
const tickets = new Map(); // bilietas -> kanalo vardas (įrašų klausymui)
function rt(name) {
  if (!live.has(name)) live.set(name, { clients: new Set(), talker: null, current: null, timer: null });
  return live.get(name);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(name, obj, except) {
  const c = live.get(name); if (!c) return;
  const s = JSON.stringify(obj);
  for (const w of c.clients) if (w !== except && w.readyState === 1) w.send(s);
}
function presence(name) {
  const c = live.get(name); if (!c) return;
  broadcast(name, {
    t: 'presence',
    users: [...c.clients].map(w => w.user),
    talker: c.talker ? c.talker.user : null
  });
}
const err = (ws, code, msg) => send(ws, { t: 'error', code, msg });

function endTalk(ws, forced = false) {
  const c = ws.chan && live.get(ws.chan);
  if (!c || c.talker !== ws) return;
  clearTimeout(c.timer);
  const cur = c.current;
  const data = Buffer.concat(cur.chunks);
  c.talker = null; c.current = null;
  const ch = db.channels[ws.chan];
  let item = null;
  if (ch && data.length >= MIN_BYTES) {
    item = { id: cur.id, from: cur.from, ts: cur.ts, dur: +(data.length / RATE).toFixed(1) };
    fs.writeFile(audioFile(item.id), data, () => {});
    ch.history.push(item);
    while (ch.history.length > HISTORY_LIMIT) rmAudio(ch.history.shift().id);
    saveDb();
  }
  broadcast(ws.chan, { t: 'stop', id: cur.id, from: cur.from, forced, item });
  presence(ws.chan);
}

function leave(ws) {
  if (!ws.chan) return;
  endTalk(ws);
  const name = ws.chan;
  const c = live.get(name);
  if (c) c.clients.delete(ws);
  if (ws.ticket) tickets.delete(ws.ticket);
  ws.chan = null; ws.ticket = null; ws.isOwner = false;
  presence(name);
}

function attach(ws, name, isOwner) {
  leave(ws);
  ws.chan = name;
  ws.isOwner = isOwner;
  ws.ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ws.ticket, name);
  rt(name).clients.add(ws);
  send(ws, { t: 'joined', channel: name, owner: isOwner, ticket: ws.ticket, history: db.channels[name].history });
  presence(name);
}

function failAuth(ws, code, msg) {
  ws.fails = (ws.fails || 0) + 1;
  setTimeout(() => {
    err(ws, code, msg);
    if (ws.fails >= 8) ws.close(4001, 'per daug bandymų');
  }, 700);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const c = ws.chan && live.get(ws.chan);
      if (!c || c.talker !== ws) return;
      c.current.chunks.push(Buffer.from(data));
      for (const w of c.clients) if (w !== ws && w.readyState === 1) w.send(data, { binary: true });
      return;
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    const ch = ws.chan && db.channels[ws.chan];

    switch (m.t) {
      case 'create': {
        const name = normChannel(m.channel);
        if (!name) return err(ws, 'badname', 'Pavadinimas: 2–32 raidės, skaičiai, - arba _');
        if (String(m.password || '').length < 4) return err(ws, 'shortpass', 'Slaptažodis turi būti bent 4 simbolių');
        if (db.channels[name]) return err(ws, 'exists', 'Toks kanalas jau yra. Pasirink kitą pavadinimą arba prisijunk.');
        ws.user = String(m.name || '').trim().slice(0, 32) || 'Be vardo';
        const salt = crypto.randomBytes(16).toString('hex');
        db.channels[name] = { salt, hash: hashPw(m.password, salt), owner: sha(m.token), created: Date.now(), history: [] };
        saveDb();
        return attach(ws, name, true);
      }
      case 'join': {
        const name = normChannel(m.channel);
        const c = name && db.channels[name];
        if (!c) return failAuth(ws, 'notfound', 'Kanalas nerastas');
        if (!checkPw(m.password || '', c)) return failAuth(ws, 'badpass', 'Neteisingas slaptažodis');
        ws.fails = 0;
        ws.user = String(m.name || '').trim().slice(0, 32) || 'Be vardo';
        return attach(ws, name, c.owner === sha(m.token));
      }
      case 'leave':
        return leave(ws);
      case 'start': {
        const c = ws.chan && live.get(ws.chan);
        if (!c) return;
        if (c.talker && c.talker !== ws) return send(ws, { t: 'busy', by: c.talker.user });
        if (c.talker === ws) return send(ws, { t: 'granted', id: c.current.id });
        c.talker = ws;
        c.current = { id: ++db.seq, from: ws.user, ts: Date.now(), chunks: [] };
        saveDb();
        c.timer = setTimeout(() => endTalk(ws, true), MAX_TALK_MS);
        send(ws, { t: 'granted', id: c.current.id });
        broadcast(ws.chan, { t: 'start', from: ws.user, id: c.current.id }, ws);
        return presence(ws.chan);
      }
      case 'stop':
        return endTalk(ws);
      case 'clear': {
        if (!ch) return;
        if (!ws.isOwner) return err(ws, 'notowner', 'Istoriją visiems gali išvalyti tik kanalo kūrėjas');
        ch.history.forEach(h => rmAudio(h.id));
        ch.history = [];
        saveDb();
        return broadcast(ws.chan, { t: 'cleared' });
      }
      case 'delete': {
        if (!ch) return;
        if (!ws.isOwner) return err(ws, 'notowner', 'Kanalą ištrinti gali tik jo kūrėjas');
        const name = ws.chan;
        broadcast(name, { t: 'deleted', channel: name });
        const c = live.get(name);
        if (c) for (const w of [...c.clients]) leave(w);
        ch.history.forEach(h => rmAudio(h.id));
        delete db.channels[name];
        live.delete(name);
        return saveDb();
      }
      case 'password': {
        if (!ch) return;
        if (!ws.isOwner) return err(ws, 'notowner', 'Slaptažodį keisti gali tik kanalo kūrėjas');
        if (String(m.password || '').length < 4) return err(ws, 'shortpass', 'Slaptažodis turi būti bent 4 simbolių');
        ch.salt = crypto.randomBytes(16).toString('hex');
        ch.hash = hashPw(m.password, ch.salt);
        saveDb();
        return send(ws, { t: 'passwordChanged' });
      }
    }
  });

  ws.on('close', () => leave(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// įrašų atkūrimas (tik turint prisijungimo bilietą)
app.get('/audio/:id', (req, res) => {
  const name = tickets.get(String(req.query.k || ''));
  const ch = name && db.channels[name];
  const id = Number(req.params.id);
  if (!ch || !ch.history.some(h => h.id === id)) return res.status(404).send('Nerasta');
  fs.readFile(audioFile(id), (e, data) => {
    if (e) return res.status(404).send('Nerasta');
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(muToWav(data));
  });
});

app.get('/health', (_, res) => res.json({ ok: true, channels: Object.keys(db.channels).length, clients: wss.clients.size, dataDir: DATA_DIR }));

server.listen(PORT, () => console.log(`Racija veikia: http://localhost:${PORT} (duomenys: ${DATA_DIR})`));
