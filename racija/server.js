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
const RETENTION_MS = (Number(process.env.RETENTION_HOURS) || 6) * 3600 * 1000;
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
db.lic = db.lic || { enabled: false, enabledAt: 0, trialDays: 14, codes: {} };
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
process.on('uncaughtException', (e) => console.error('Nepagauta klaida:', e));
process.on('unhandledRejection', (e) => console.error('Nepagautas pažadas:', e));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushDb(); process.exit(0); });
// įrašų šifravimas diske (AES-256-GCM); raktas iš AUDIO_KEY arba ADMIN_KEY
const KEY_SRC = process.env.AUDIO_KEY || ADMIN_KEY;
const AUDIO_KEY = KEY_SRC ? crypto.createHash('sha256').update('vc-audio:' + KEY_SRC).digest() : null;
function encAudio(buf) {
  if (!AUDIO_KEY) return buf;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', AUDIO_KEY, iv);
  const e = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('VC1'), iv, c.getAuthTag(), e]);
}
function decAudio(buf) {
  if (buf.subarray(0, 3).toString() !== 'VC1') return buf;
  if (!AUDIO_KEY) throw new Error('nėra rakto');
  const d = crypto.createDecipheriv('aes-256-gcm', AUDIO_KEY, buf.subarray(3, 15));
  d.setAuthTag(buf.subarray(15, 31));
  return Buffer.concat([d.update(buf.subarray(31)), d.final()]);
}

// neteisingų bandymų ribojimas pagal IP (slaptažodžiai ir admin raktas)
const AUTH_MAX = 6, AUTH_WINDOW = 10 * 60 * 1000, AUTH_BLOCK = 15 * 60 * 1000;
const authFails = new Map();
const ipBlocked = (ip) => { const a = authFails.get(ip); return !!a && a.until > Date.now(); };
function noteFail(ip) {
  const now = Date.now();
  let a = authFails.get(ip);
  if (!a || now - a.first > AUTH_WINDOW) a = { n: 0, first: now, until: 0 };
  if (++a.n >= AUTH_MAX) a.until = now + AUTH_BLOCK;
  authFails.set(ip, a);
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of authFails) if (a.until < now && now - a.first > AUTH_WINDOW) authFails.delete(ip); }, 60 * 1000);
const MIN_PW = 6;

const audioFile = (id) => path.join(AUDIO_DIR, `${id}.ulaw`);
const rmAudio = (id) => fs.unlink(audioFile(id), () => {});

// ---------- senų įrašų trynimas ----------
function prune() {
  const cut = Date.now() - RETENTION_MS;
  let changed = false;
  for (const ch of Object.values(db.channels)) {
    if (ch.timer && ch.timer.end < Date.now() - 3600000) { ch.timer = null; changed = true; }
    if (ch.meet && ch.meet.ts < Date.now() - 24 * 3600000) { ch.meet = null; changed = true; }
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
const tickets = new Map(); // bilietas -> { chan, until }
const TICKET_GRACE_MS = 2 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, t] of tickets) if (t.until < now) tickets.delete(k); }, 60 * 1000);
let connSeq = 0;
function rt(name) {
  if (!live.has(name)) live.set(name, { clients: new Set(), talker: null, current: null, timer: null, locs: new Map() });
  return live.get(name);
}
const isOwner = (w, ch) => !!ch && ch.owners.includes(w.tokenHash);
const canManage = (w) => !!w.chan && (w.isAdmin || isOwner(w, db.channels[w.chan]));

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(self)'
  });
  next();
});
// sąsajos versija: įrašoma į puslapį, kad atidaryti telefonai pastebėtų naują versiją ir persikrautų
const INDEX_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const WEBVER = crypto.createHash('sha256').update(INDEX_RAW).update(fs.readFileSync(path.join(__dirname, 'public', 'sw.js'))).digest('hex').slice(0, 12);
const INDEX_HTML = INDEX_RAW.replace('__WEBVER__', WEBVER);
const sendIndex = (_, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(INDEX_HTML); };
app.get(['/', '/index.html', '/join'], sendIndex); // kvietimo nuoroda: /join?c=kanalas&k=slaptažodis
app.get('/webver', (_, res) => res.set('Cache-Control', 'no-store').json({ v: WEBVER }));
const APK_SHA256 = process.env.APK_SHA256 || '2A:08:02:BA:C0:B5:4C:0D:72:E4:88:46:6A:1F:D1:47:50:0A:F8:C7:02:A9:2F:5C:BC:69:99:E6:69:6B:36:70';
app.get('/.well-known/assetlinks.json', (_, res) => res.json([{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: 'lt.voicech311', sha256_cert_fingerprints: [APK_SHA256] }
}]));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });
wss.on('error', (e) => console.error('wss klaida:', e.message));

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
    if (cur.cmd) item.voiceCmd = cur.cmd;
    fs.writeFile(audioFile(item.id), encAudio(data), () => {});
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
  if (ws.ticket && tickets.has(ws.ticket)) tickets.get(ws.ticket).until = Date.now() + TICKET_GRACE_MS;
  ws.chan = null; ws.ticket = null;
  presence(name);
}

function uniqueName(ws, name) {
  const c = live.get(name); if (!c) return;
  const taken = new Set([...c.clients].filter(w => w !== ws).map(w => w.user.toLowerCase()));
  if (!taken.has(ws.user.toLowerCase())) return;
  let i = 2; while (taken.has(`${ws.user} (${i})`.toLowerCase())) i++;
  ws.user = `${ws.user} (${i})`;
}

// ---------- narių vietos (tik atmintyje, tik to kanalo nariams; niekur nesaugoma) ----------
const LOC_MAX_AGE = 15 * 60 * 1000;
const locId = (w) => sha('loc:' + w.tokenHash).slice(0, 10);
function locList(c) {
  const now = Date.now();
  return [...c.locs.entries()].filter(([, l]) => (!l.until || l.until > now) && now - l.ts < LOC_MAX_AGE)
    .map(([id, l]) => ({ id, name: l.name, lat: l.lat, lon: l.lon, acc: l.acc, ts: l.ts, until: l.until }));
}
function broadcastLocs(name) {
  const c = live.get(name); if (!c) return;
  clearTimeout(c.locTimer);
  const wait = 1000 - (Date.now() - (c.locSent || 0));
  const go = () => { c.locSent = Date.now(); broadcast(name, { t: 'locs', list: locList(c), now: Date.now() }); };
  if (wait <= 0) go(); else c.locTimer = setTimeout(go, wait); // ne dažniau nei kas 1 s
}
setInterval(() => {
  const now = Date.now();
  for (const [name, c] of live) {
    let changed = false;
    for (const [k, l] of c.locs) if ((l.until && l.until <= now) || now - l.ts >= LOC_MAX_AGE) { c.locs.delete(k); changed = true; }
    if (changed) broadcastLocs(name);
  }
}, 30 * 1000);

// ---------- licencijos (grupei) ----------
const DAY = 24 * 3600000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newLicCode() {
  const part = () => Array.from(crypto.randomBytes(4), b => CODE_ABC[b % CODE_ABC.length]).join('');
  let c; do { c = `VC-${part()}-${part()}`; } while (db.lic.codes[c]);
  return c;
}
const normLic = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VC/, '').replace(/^(.{4})(.{4})$/, 'VC-$1-$2');
function licStatus(name) {
  const ch = db.channels[name];
  if (!ch) return { ok: false, kind: 'none' };
  if (!db.lic.enabled) return { ok: true, kind: 'off' };
  if (ch.free) return { ok: true, kind: 'free' };
  const L = ch.license && db.lic.codes[ch.license];
  if (L && L.until > Date.now()) return { ok: true, kind: 'lic', org: L.org, until: L.until, maxUsers: L.maxUsers };
  const trialEnd = Math.max(ch.created || 0, db.lic.enabledAt || 0) + db.lic.trialDays * DAY;
  if (Date.now() < trialEnd) return { ok: true, kind: 'trial', until: trialEnd, expired: L ? L.until : undefined };
  return { ok: false, kind: L ? 'licExpired' : 'expired', org: L ? L.org : undefined, until: L ? L.until : trialEnd };
}
const licOk = (ws) => ws.isAdmin || !ws.chan || licStatus(ws.chan).ok;
function licDenied(ws) {
  return err(ws, 'license', canManage(ws) ? 'Grupės licencija baigėsi. Meniu ⋯ → 🎫 Licencija įvesk kodą.' : 'Grupės licencija baigėsi. Kreipkis į grupės kūrėją.');
}
function pushLic(name) { if (live.has(name)) broadcast(name, { t: 'lic', lic: licStatus(name) }); }
function pushLicAll() { for (const name of live.keys()) pushLic(name); }
function adminLicView() {
  const used = {};
  for (const [n, c] of Object.entries(db.channels)) if (c.license) (used[c.license] = used[c.license] || []).push(n);
  return {
    enabled: db.lic.enabled, trialDays: db.lic.trialDays,
    codes: Object.entries(db.lic.codes).map(([code, L]) => ({ code, ...L, channels: used[code] || [] })).sort((a, b) => b.created - a.created)
  };
}
// kas valandą – pranešti apie pasibaigusias licencijas prisijungusiems
setInterval(pushLicAll, 3600000);

// ---------- laikmatis ----------
const timerView = (ch) => ch && ch.timer ? { title: ch.timer.title, start: ch.timer.start, end: ch.timer.end, by: ch.timer.by } : null;
function checkCode(code, ch) {
  if (!ch.timerCode) return false;
  const a = Buffer.from(hashPw(code, ch.timerCode.salt), 'hex'), b = Buffer.from(ch.timerCode.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function pushHist(ch, item) {
  ch.history.push(item);
  while (ch.history.length > HISTORY_LIMIT) rmAudio(ch.history.shift().id);
  saveDb();
}

function attach(ws, name) {
  leave(ws);
  uniqueName(ws, name);
  ws.chan = name;
  ws.ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ws.ticket, { chan: name, until: Infinity });
  rt(name).clients.add(ws);
  send(ws, { t: 'joined', channel: name, owner: canManage(ws), admin: !!ws.isAdmin, public: !!db.channels[name].public, ticket: ws.ticket, history: db.channels[name].history, timer: timerView(db.channels[name]), timerCode: !!db.channels[name].timerCode, meet: db.channels[name].meet || null, now: Date.now(), locId: locId(ws), locs: locList(rt(name)), lic: licStatus(name) });
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
  noteFail(ws.ip);
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
    msgs: ch.history.length, owners: ch.owners.length, free: !!ch.free, license: ch.license || null, lic: licStatus(name)
  })).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
}

wss.on('connection', (ws, req) => {
  ws.id = ++connSeq;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  ws.ip = req.headers['x-real-ip'] || xff[xff.length - 1] || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on('error', () => { try { ws.terminate(); } catch {} }); // netinkamas kadras neturi numušti serverio
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const c = ws.chan && live.get(ws.chan);
      if (!c || c.talker !== ws) return;
      if (data.length > 16384) return;                       // per didelis kadras
      c.current.bytes = (c.current.bytes || 0) + data.length;
      if (c.current.bytes > RATE * (MAX_TALK_MS / 1000 + 5)) return endTalk(ws, true); // daugiau nei 65 s garso
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
        if (String(m.password || '').length < MIN_PW) return err(ws, 'shortpass', `Slaptažodis turi būti bent ${MIN_PW} simbolių`);
        if (db.channels[name]) return err(ws, 'exists', 'Toks kanalas jau yra. Pasirink kitą pavadinimą arba prisijunk.');
        setUser(ws, m);
        db.channels[name] = { owners: [ws.tokenHash], created: Date.now(), history: [], public: !!m.public };
        setPw(db.channels[name], m.password);
        saveDb();
        return attach(ws, name);
      }
      case 'join': {
        if (ipBlocked(ws.ip)) return err(ws, 'blocked', 'Per daug neteisingų bandymų. Pabandyk po 15 min.');
        const name = normChannel(m.channel);
        const c = name && db.channels[name];
        if (!c) return failAuth(ws, 'notfound', 'Kanalas nerastas');
        if (!checkPw(m.password || '', c)) return failAuth(ws, 'badpass', 'Neteisingas slaptažodis');
        ws.fails = 0;
        const ls = licStatus(name), lc = live.get(name);
        if (!ws.isAdmin && ls.kind === 'lic' && ls.maxUsers && lc && [...lc.clients].filter(w => w !== ws && !w.isAdmin).length >= ls.maxUsers)
          return err(ws, 'full', `Grupė pilna: licencija leidžia ${ls.maxUsers} prisijungusius vienu metu`);
        setUser(ws, m);
        return attach(ws, name);
      }
      case 'leave':
        return leave(ws);

      // ----- bendras grupių sąrašas (tik pavadinimai; įeiti reikia slaptažodžio) -----
      case 'publicList':
        return send(ws, { t: 'publicList', channels: Object.entries(db.channels).filter(([, c]) => c.public)
          .map(([name]) => ({ name, online: live.has(name) ? live.get(name).clients.size : 0 }))
          .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)) });
      case 'loc': {
        if (!ch) return;
        if (!licOk(ws)) return;
        const lat = Number(m.lat), lon = Number(m.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        const c = rt(ws.chan), now = Date.now();
        const until = Number(m.until) > now ? Math.min(Number(m.until), now + 24 * 3600000) : null;
        c.locs.set(locId(ws), { name: ws.user, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
          acc: Math.min(9999, Math.max(0, Math.round(Number(m.acc) || 0))), ts: now, until });
        return broadcastLocs(ws.chan);
      }
      case 'locStop': {
        if (!ws.chan) return;
        const c = live.get(ws.chan);
        if (c && c.locs.delete(locId(ws))) broadcastLocs(ws.chan);
        return;
      }
      case 'meetSet':
      case 'meetClear': {
        if (!ch) return;
        if (!licOk(ws)) return licDenied(ws);
        if (!canManage(ws)) {
          if (!ch.timerCode) return err(ws, 'notimerperm', 'Susitikimo vietą nustato kanalo kūrėjas. Paprašyk jo valdymo kodo.');
          if (ipBlocked(ws.ip)) return err(ws, 'blocked', 'Per daug neteisingų bandymų. Pabandyk po 15 min.');
          if (!m.code || !checkCode(String(m.code), ch)) return failAuth(ws, 'badcode', 'Neteisingas valdymo kodas');
        }
        const now = Date.now();
        let item;
        if (m.t === 'meetClear') {
          if (!ch.meet) return;
          item = { id: ++db.seq, from: ws.user, ts: now, dur: 0, cmd: ch.meet.title, meet: 'clear' };
          ch.meet = null;
        } else {
          const lat = Number(m.lat), lon = Number(m.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return err(ws, 'badplace', 'Netinkama vieta');
          const title = String(m.title || 'Susitikimo vieta').trim().slice(0, 40) || 'Susitikimo vieta';
          ch.meet = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, title, by: ws.user, ts: now };
          item = { id: ++db.seq, from: ws.user, ts: now, dur: 0, cmd: title, meet: 'set' };
        }
        pushHist(ch, item);
        return broadcast(ws.chan, { t: 'meet', meet: ch.meet || null, item });
      }
      case 'timerSet':
      case 'timerStop': {
        if (!ch) return;
        if (!licOk(ws)) return licDenied(ws);
        if (!canManage(ws)) {
          if (!ch.timerCode) return err(ws, 'notimerperm', 'Laikmatį nustato kanalo kūrėjas. Paprašyk jo valdymo kodo.');
          if (ipBlocked(ws.ip)) return err(ws, 'blocked', 'Per daug neteisingų bandymų. Pabandyk po 15 min.');
          if (!m.code || !checkCode(String(m.code), ch)) return failAuth(ws, 'badcode', 'Neteisingas valdymo kodas');
        }
        const now = Date.now();
        let item;
        if (m.t === 'timerStop') {
          if (!ch.timer) return;
          item = { id: ++db.seq, from: ws.user, ts: now, dur: 0, cmd: ch.timer.title, timer: 'stop' };
          ch.timer = null;
        } else {
          let end, start = now, kind = 'set';
          if (m.extendMin && ch.timer) { end = Math.max(ch.timer.end, now) + Number(m.extendMin) * 60000; start = ch.timer.start; kind = 'extend'; }
          else if (m.endAt) end = Number(m.endAt);
          else end = now + Number(m.minutes) * 60000;
          if (!Number.isFinite(end) || end < now + 30000 || end > now + 7 * 24 * 3600000)
            return err(ws, 'badtime', 'Netinkamas laikas: nuo 1 min. iki 7 parų');
          const title = String(m.title || (ch.timer && ch.timer.title) || 'Susitikimas').trim().slice(0, 40) || 'Susitikimas';
          ch.timer = { title, start, end: Math.round(end), by: ws.user };
          item = { id: ++db.seq, from: ws.user, ts: now, dur: 0, cmd: title, timer: kind, end: ch.timer.end };
        }
        pushHist(ch, item);
        return broadcast(ws.chan, { t: 'timer', timer: timerView(ch), now, item });
      }
      case 'timerCode': {
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Valdymo kodą nustato tik kūrėjas');
        const code = String(m.code || '');
        if (!code) ch.timerCode = null;
        else {
          if (code.length < 4) return err(ws, 'shortcode', 'Kodas turi būti bent 4 simbolių');
          const salt = crypto.randomBytes(16).toString('hex');
          ch.timerCode = { salt, hash: hashPw(code, salt) };
        }
        saveDb();
        return broadcast(ws.chan, { t: 'timerCode', on: !!ch.timerCode });
      }
      case 'setPublic':
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Keisti gali tik kūrėjas');
        ch.public = !!m.on; saveDb();
        return send(ws, { t: 'publicSet', on: ch.public });

      // ----- kalbėjimas -----
      case 'start': {
        const c = ws.chan && live.get(ws.chan);
        if (!c) return;
        if (!licOk(ws)) return licDenied(ws);
        if (c.talker && c.talker !== ws) return send(ws, { t: 'busy', by: c.talker.user });
        if (c.talker === ws) return send(ws, { t: 'granted', id: c.current.id });
        c.talker = ws;
        const cmd = m.cmd ? String(m.cmd).slice(0, 40) : undefined;
        c.current = { id: ++db.seq, from: ws.user, ts: Date.now(), chunks: [], cmd };
        saveDb();
        c.timer = setTimeout(() => endTalk(ws, true), MAX_TALK_MS);
        send(ws, { t: 'granted', id: c.current.id });
        broadcast(ws.chan, { t: 'start', from: ws.user, id: c.current.id, cmd }, ws);
        return presence(ws.chan);
      }

      // ----- greitos komandos ir STOP signalas -----
      case 'cmd': {
        if (!ch) return;
        if (!licOk(ws)) return licDenied(ws);
        const now = Date.now();
        const text = String(m.text || '').trim().slice(0, 40) || 'Komanda';
        if (now - (ws.lastCmd || 0) < 800 && ws.lastCmdText === text) return; // tos pačios komandos dvigubas paspaudimas
        ws.lastCmd = now; ws.lastCmdText = text;
        const alarm = !!m.alarm;
        const c = live.get(ws.chan);
        // STOP nutraukia bet kurį tuo metu kalbantį
        if (alarm && c && c.talker && c.talker !== ws) {
          const t = c.talker; endTalk(t, 'alarm'); send(t, { t: 'toast', msg: `🚨 ${ws.user}: ${text}` });
        }
        const cid = /^[0-9a-z]{6}$/.test(String(m.cid || '')) ? m.cid : undefined; // bendras id su LoRa žinute
        const item = { id: ++db.seq, from: ws.user, ts: now, dur: 0, cmd: text, alarm, cid };
        ch.history.push(item);
        while (ch.history.length > HISTORY_LIMIT) rmAudio(ch.history.shift().id);
        saveDb();
        return broadcast(ws.chan, { t: 'cmd', from: ws.user, text, alarm, voice: !!m.voice, cid, item });
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
        if (String(m.password || '').length < MIN_PW) return err(ws, 'shortpass', `Slaptažodis turi būti bent ${MIN_PW} simbolių`);
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

      // ----- licencija -----
      case 'licApply': {
        if (!ch) return;
        if (!canManage(ws)) return err(ws, 'notowner', 'Licencijos kodą įveda grupės kūrėjas');
        if (ipBlocked(ws.ip)) return err(ws, 'blocked', 'Per daug neteisingų bandymų. Pabandyk po 15 min.');
        const code = normLic(m.code), L = db.lic.codes[code];
        if (!L) return failAuth(ws, 'badlic', 'Toks licencijos kodas nerastas');
        if (L.until <= Date.now()) return err(ws, 'badlic', 'Šio kodo galiojimas baigėsi');
        const usedBy = Object.entries(db.channels).filter(([n, c]) => c.license === code && n !== ws.chan).length;
        if (usedBy >= (L.maxChannels || 1)) return err(ws, 'badlic', `Šis kodas jau naudojamas ${usedBy} grupėse (leidžiama ${L.maxChannels || 1})`);
        ws.fails = 0;
        ch.license = code; saveDb();
        send(ws, { t: 'toast', msg: `🎫 Licencija aktyvuota: ${L.org}` });
        return pushLic(ws.chan);
      }
      case 'licInfo':
        if (!ch) return;
        return send(ws, { t: 'lic', lic: licStatus(ws.chan), code: canManage(ws) ? (ch.license || null) : undefined });

      // ----- administratorius -----
      case 'admin':
        if (ipBlocked(ws.ip)) return err(ws, 'blocked', 'Per daug neteisingų bandymų. Pabandyk po 15 min.');
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
      case 'adminLic':
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        return send(ws, { t: 'adminLic', ...adminLicView(), channels: adminList() });
      case 'adminLicSet': case 'adminLicCreate': case 'adminLicExtend': case 'adminLicDelete': case 'adminLicEdit': case 'adminFree': {
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        let msg = 'Išsaugota';
        if (m.t === 'adminLicSet') {
          if (m.enabled !== undefined) {
            const on = !!m.enabled;
            if (on && !db.lic.enabled) db.lic.enabledAt = Date.now();
            db.lic.enabled = on; msg = on ? 'Licencijavimas įjungtas' : 'Licencijavimas išjungtas – visi naudoja nemokamai';
          }
          if (m.trialDays !== undefined) db.lic.trialDays = Math.max(0, Math.min(365, Math.round(Number(m.trialDays) || 0)));
        } else if (m.t === 'adminLicCreate') {
          const org = String(m.org || '').trim().slice(0, 60);
          if (!org) return err(ws, 'badorg', 'Įrašyk organizacijos pavadinimą');
          const months = Math.max(1, Math.min(60, Math.round(Number(m.months) || 12)));
          const code = newLicCode();
          db.lic.codes[code] = { org, maxUsers: Math.max(0, Math.min(1000, Math.round(Number(m.maxUsers) || 0))),
            maxChannels: Math.max(1, Math.min(50, Math.round(Number(m.maxChannels) || 1))),
            until: Date.now() + months * 30 * DAY, created: Date.now(), note: String(m.note || '').slice(0, 120) };
          msg = `Sukurtas kodas ${code}`;
        } else {
          if (m.t !== 'adminFree') {
            const L = db.lic.codes[String(m.code || '')];
            if (!L) return err(ws, 'badlic', 'Kodas nerastas');
            if (m.t === 'adminLicExtend') {
              L.until = Math.max(L.until, Date.now()) + Math.max(-60, Math.min(60, Math.round(Number(m.months) || 0))) * 30 * DAY;
              msg = `${L.org}: galioja iki ${new Date(L.until).toISOString().slice(0, 10)}`;
            } else if (m.t === 'adminLicEdit') {
              if (m.maxUsers !== undefined) L.maxUsers = Math.max(0, Math.min(1000, Math.round(Number(m.maxUsers) || 0)));
              if (m.maxChannels !== undefined) L.maxChannels = Math.max(1, Math.min(50, Math.round(Number(m.maxChannels) || 1)));
            } else {
              delete db.lic.codes[m.code];
              for (const c of Object.values(db.channels)) if (c.license === m.code) delete c.license;
              msg = `Kodas ${m.code} ištrintas`;
            }
          } else {
            const name = normChannel(m.channel), c = name && db.channels[name];
            if (!c) return err(ws, 'notfound', 'Kanalas nerastas');
            c.free = !!m.on; msg = `#${name}: ${c.free ? 'nemokamas visam laikui' : 'pagal licenciją'}`;
          }
        }
        saveDb(); pushLicAll();
        return send(ws, { t: 'adminLic', msg, ...adminLicView(), channels: adminList() });
      }
      case 'adminPassword': case 'adminResetOwners': case 'adminDelete': {
        if (!ws.isAdmin) return err(ws, 'notadmin', 'Reikia administratoriaus teisių');
        const name = normChannel(m.channel), c = name && db.channels[name];
        if (!c) return err(ws, 'notfound', 'Kanalas nerastas');
        let msg;
        if (m.t === 'adminPassword') {
          if (String(m.password || '').length < MIN_PW) return err(ws, 'shortpass', `Slaptažodis turi būti bent ${MIN_PW} simbolių`);
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
  const id = Number(req.params.id);
  const fail = (reason) => { console.warn(`įrašas ${id}: ${reason}`); res.set('X-Reason', reason); return res.status(404).send('Nerasta'); };
  const t = tickets.get(String(req.query.k || ''));
  if (!t || t.until < Date.now()) return fail('ticket');
  const ch = db.channels[t.chan];
  if (!ch || !ch.history.some(h => h.id === id)) return fail('deleted');
  fs.readFile(audioFile(id), (e, data) => {
    if (e) return fail('file');
    try { data = decAudio(data); } catch { return fail('decrypt'); }
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(muToWav(data));
  });
});

app.get('/apk', (_, res) => res.redirect(process.env.APK_URL || 'https://github.com/sauliusmazrimo-cmyk/racija/releases/download/android-latest/311VoiceCH.apk'));

// naujausios Android versijos informacija (iš GitHub Releases, laikoma 10 min.)
const VERSION_URL = process.env.APK_VERSION_URL || 'https://github.com/sauliusmazrimo-cmyk/racija/releases/download/android-latest/version.json';
let verCache = { at: 0, data: { code: 0 } };
app.get('/version', async (_, res) => {
  if (Date.now() - verCache.at > 10 * 60 * 1000) {
    try {
      const r = await fetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const d = await r.json(); if (Number.isFinite(+d.code)) verCache = { at: Date.now(), data: { code: +d.code, name: String(d.name || ''), notes: String(d.notes || '').slice(0, 500) } }; }
      else verCache.at = Date.now() - 9 * 60 * 1000; // bandom vėl po minutės
    } catch { verCache.at = Date.now() - 9 * 60 * 1000; }
  }
  res.set('Cache-Control', 'no-store').json(verCache.data);
});

// monoklio programa (GitHub Releases per serverį, kad naršyklė galėtų ją įrašyti per USB)
const FW_BASE = process.env.FW_BASE || 'https://github.com/sauliusmazrimo-cmyk/racija/releases/download/monoklis-latest/';
let fwCache = { at: 0, bin: null, ver: '' };
async function loadFw() {
  if (fwCache.bin && Date.now() - fwCache.at < 10 * 60 * 1000) return fwCache;
  try {
    const j = await fetch(FW_BASE + 'monoklis.json', { signal: AbortSignal.timeout(8000) });
    const ver = j.ok ? String((await j.json()).version || '') : '';
    if (!fwCache.bin || ver !== fwCache.ver) {
      const r = await fetch(FW_BASE + 'monoklis.bin', { signal: AbortSignal.timeout(30000) });
      if (r.ok) fwCache = { at: Date.now(), bin: Buffer.from(await r.arrayBuffer()), ver };
    } else fwCache.at = Date.now();
  } catch {}
  return fwCache;
}
app.get('/monoklis', (_, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'monoklis.html')));
app.get('/fw/manifest.json', async (_, res) => {
  const f = await loadFw();
  res.set('Cache-Control', 'no-store').json({
    name: '311 VoiceCH monoklis', version: f.ver ? '1.0.' + f.ver : '', new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32-C3', parts: [{ path: '/fw/monoklis.bin?v=' + f.ver, offset: 0 }] }]
  });
});
app.get('/fw/monoklis.bin', async (_, res) => {
  const f = await loadFw();
  if (!f.bin) return res.status(503).send('nepasiekiama');
  res.set('Cache-Control', 'no-cache').type('application/octet-stream').send(f.bin);
});

app.get('/health', (_, res) => res.json({
  ok: true, version: '0.9', channels: Object.keys(db.channels).length, clients: wss.clients.size,
  persistent: !!process.env.RAILWAY_VOLUME_MOUNT_PATH, admin: !!ADMIN_KEY, retentionHours: RETENTION_MS / 3600000, encrypted: !!AUDIO_KEY
}));

server.listen(PORT, () => console.log(`311 VoiceCH v0.9: http://localhost:${PORT} (duomenys: ${DATA_DIR}, admin: ${ADMIN_KEY ? 'taip' : 'ne'})`));
