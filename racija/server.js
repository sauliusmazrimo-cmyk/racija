// Racija v0.3 – push-to-talk serveris
// Balsas: 16 kHz, G.711 mu-law (1 baitas/mėginys), realiu laiku per WebSocket.
// Kanalai su slaptažodžiais, keli kūrėjai, administratorius (ADMIN_KEY), įrašai trinami po RETENTION_HOURS.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const RETENTION_MS = (Number(process.env.RETENTION_HOURS) || 48) * 3600 * 1000;
const RATE = 16000;
const MAX_TALK_MS = 60000;
const HISTORY_LIMIT = 50;
const MIN_BYTES = RATE * 0.3;

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------- duomenų bazė ----------
let db = { seq: 0, channels: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
db.channels = db.channels || {};
for (const ch of Object.values(db.channels)) { // migracija iš v0.2
  if (!Array.isArray(ch.owners)) ch.owners = ch.owner ? [ch.owner] : [];
  delete ch.owner;
}
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
const audioFile = (id) => path.join(AUDIO_DIR, `${id}.ulaw`);
const rmAudio = (id) => fs.unlink(audioFile(id), () => {});

// ---------- senų įrašų trynimas ----------
function prune() {
  const cut = Date.now() - RETENTION_MS;
  let changed = false;
  for (const ch of Object.values(db.channels)) {
    const keep = [];
    for (const h of ch.history) { if (h.ts < cut) { rmAudio(h.id); changed = true; } else keep.push(h); }
    ch.history = keep;
  }
  if (changed) saveDb();
}
function removeOrphans() { // failai be įrašo istorijoje (pvz. po avarinio išsijungimo)
  const ids = new Set();
  for (const ch of Object.values(db.channels)) ch.history.forEach(h => ids.add(String(h.id)));
  for (const f of fs.readdirSync(AUDIO_DIR)) if (!ids.has(f.replace('.ulaw', ''))) fs.unlink(path.join(AUDIO_DIR, f), () => {});
}
prune(); removeOrphans();
setInterval(prune, 10 * 60 * 1000);

// ---------- saugumas ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function checkPw(pw, ch) {
  const a = Buffer.from(hashPw(pw, ch.salt), 'hex'), b = Buffer.from(ch.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPw(ch, pw) { ch.salt = crypto.randomBytes(16).toString('hex'); ch.hash = hashPw(pw, ch.salt); }
function checkAdmin(key) {
  if (!ADMIN_KEY) return false;
  const a = Buffer.from(sha(key), 'hex'), b = Buffer.from(sha(ADMIN_KEY), 'hex');
  return crypto.timingSafeEqual(a, b);
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
const live = new Map();
const tickets = new Map();
let connSeq = 0;
function rt(name) {
  if (!live.has(name)) live.set(name, { clients: new Set(), talker: null, current: null, timer: null });
  return live.get(name);
}
const isOwner = (w, ch) => !!ch && ch.owners.includes(w.tokenHash);
const canManage = (w) => !!w.chan && (w.isAdmin || isOwner(w, db.channels[w.chan]));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
const err = (ws, code, msg) => send(ws, { t: 'error', code, msg });
function broadcast(name, obj, except) {
  const c = live.get(name); if (!c) return;
  const s = JSON.stringify(obj);
  for (const w of c.clients) if (w !== except && w.readyState === 1) w.send(s);
}
function presence(name) {
  const c = live.get(name); const ch = db.channels[name];
  if (!c || !ch) return;
  const users = [...c.clients].map(w => ({ id: w.id, name: w.user, owner: isOwner(w, ch) || !!w.isAdmin }));
  const talker = c.talker ? c.talker.user : null;
  for (const w of c.clients) send(w, { t: 'presence', users, talker, me: { id: w.id, owner: canManage(w), admin: !!w.isAdmin } });
}

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
  ws.chan = null; ws.ticket = null;
  presence(name);
}

function attach(ws, name) {
  leave(ws);
  ws.chan = name;
  ws.ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ws.ticket, name);
  rt(name).clients.add(ws);
  send(ws, { t: 'joined', channel: name, owner: canManage(ws), admin: !!ws.isAdmin, ticket: ws.ticket, history: db.channels[name].history });
  presence(name);
}

function deleteChannel(name) {
  const ch = db.channels[name]; if (!ch) return;
  broadcast(name, { t: 'deleted', channel: name });
  const c = live.get(name);
  if (c) for (const w of [...c.clients]) leave(w);
  ch.history.forEach(h => rmAudio(h.id));
  delete db.channels[name];
  live.delete(name);
  saveDb();
}

function failAuth(ws, code, msg) {
  ws.fails = (ws.fails || 0) + 1;
  setTimeout(() => {
    err(ws, code, msg);
    if (ws.fails >= 8) ws.close(4001, 'per daug bandymų');
  }, 700);
}
const setUser = (ws, m) => {
  ws.user = String(m.name || '').trim().slice(0, 32) || 'Be vardo';
  ws.tokenHash = sha(m.token || crypto.randomBytes(8));
};
function findClient(name, id) {
  const c = live.get(name); if (!c) return null;
  for (const w of c.clients) if (w.id === id) return w;
  return null;
}
function adminList() {
  return Object.entries(db.channels).map(([name, ch]) => ({
    name, created: ch.created, online: live.has(name) ? live.get(name).clients.size : 0,
    msgs: ch.history.length, owners: ch.owners.length
  })).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
}

wss.on('connection', (ws) => {
  ws.id = ++connSeq;
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
      // ----- kanalai -----
      case 'create': {
        const name = normChannel(m.channel);
        if (!name) return err(ws, 'badname', 'Pavadinimas: 2–32 raidės, skaičiai, - arba _');
        if (String(m.password || '').length < 4) return err(ws, 'shortpass', 'Slaptažodis turi būti bent 4 simbolių');
        if (db.channels[name]) return err(ws, 'exists', 'Toks kanalas jau yra. Pasirink kitą pavadinimą arba prisijunk.');
        setUser(ws, m);
        db.channels[name] = { owners: [ws.tokenHash], created: Date.now(), history: [] };
        setPw(db.channels[name], m.password);
        saveDb();
        return attach(ws, name);
      }
      case 'join': {
        const name = normChannel(m.channel);
        const c = name && db.channels[name];
        if (!c) return failAuth(ws, 'notfound', 'Kanalas nerastas');
        if (!checkPw(m.password || '', c)) return failAuth(ws, 'badpass', 'Neteisingas slaptažodis');
        ws.fails = 0;
        setUser(ws, m);
        return attach(ws, name);
      }
      case 'leave':
        return leave(ws);

      // ----- kalbėjimas -----
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

      // ----- kūrėjo veiksmai -----
      case 'clear': {
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Istoriją visiems gali išvalyti tik kūrėjas');
        ch.history.forEach(h => rmAudio(h.id));
        ch.history = [];
        saveDb();
        return broadcast(ws.chan, { t: 'cleared' });
      }
      case 'delete':
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Kanalą ištrinti gali tik kūrėjas');
        return deleteChannel(ws.chan);
      case 'password': {
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Slaptažodį keisti gali tik kūrėjas');
        if (String(m.password || '').length < 4) return err(ws, 'shortpass', 'Slaptažodis turi būti bent 4 simbolių');
        setPw(ch, m.password);
        saveDb();
        return send(ws, { t: 'passwordChanged' });
      }
      case 'grant':
      case 'revoke': {
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Teises keisti gali tik kūrėjas');
        const target = findClient(ws.chan, Number(m.target));
        if (!target) return err(ws, 'nouser', 'Narys nebeprisijungęs');
        ch.owners = ch.owners.filter(h => h !== target.tokenHash);
        if (m.t === 'grant') ch.owners.push(target.tokenHash);
        saveDb();
        send(target, { t: 'toast', msg: m.t === 'grant' ? '👑 Tau suteiktos kūrėjo teisės' : 'Kūrėjo teisės nuimtos' });
        return presence(ws.chan);
      }

      // ----- administratorius -----
      case 'admin':
        if (!ADMIN_KEY) return err(ws, 'noadmin', 'Serveryje nenustatytas ADMIN_KEY');
        if (!checkAdmin(m.key || '')) return failAuth(ws, 'badadmin', 'Neteisingas administratoriaus raktas');
        ws.fails = 0; ws.isAdmin = true;
        send(ws, { t: 'adminOk' });
        if (ws.chan) presence(ws.chan);
        return;
      case 'adminList':
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        return send(ws, { t: 'adminList', channels: adminList() });
      case 'adminJoin': {
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        const name = normChannel(m.channel);
        if (!name || !db.channels[name]) return err(ws, 'notfound', 'Kanalas nerastas');
        setUser(ws, m);
        return attach(ws, name);
      }
      case 'adminPassword': case 'adminResetOwners': case 'adminDelete': {
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        const name = normChannel(m.channel), c = name && db.channels[name];
        if (!c) return err(ws, 'notfound', 'Kanalas nerastas');
        let msg;
        if (m.t === 'adminPassword') {
          if (String(m.password || '').length < 4) return err(ws, 'shortpass', 'Slaptažodis turi būti bent 4 simbolių');
          setPw(c, m.password); msg = `#${name}: slaptažodis pakeistas`;
        } else if (m.t === 'adminResetOwners') {
          c.owners = []; msg = `#${name}: kūrėjų teisės nuimtos`; presence(name);
        } else {
          deleteChannel(name); msg = `#${name} ištrintas`;
        }
        saveDb();
        return send(ws, { t: 'adminDone', msg, channel: name, action: m.t, channels: adminList() });
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

// Android programėlė (kompiliuoja GitHub Actions)
app.get('/apk', (_, res) => res.redirect(process.env.APK_URL || 'https://github.com/sauliusmazrimo-cmyk/racija/releases/download/android-latest/311VoiceCH.apk'));

app.get('/health', (_, res) => res.json({
  ok: true, version: '0.3', channels: Object.keys(db.channels).length, clients: wss.clients.size,
  dataDir: DATA_DIR, persistent: !!process.env.RAILWAY_VOLUME_MOUNT_PATH, admin: !!ADMIN_KEY, retentionHours: RETENTION_MS / 3600000
}));

server.listen(PORT, () => console.log(`Racija v0.3: http://localhost:${PORT} (duomenys: ${DATA_DIR}, admin: ${ADMIN_KEY ? 'taip' : 'ne'})`));
