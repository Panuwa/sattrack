// ตัวเก็บข้อมูลเรือ (AIS collector)
// - ต่อ AISStream ค้างไว้ตลอดเวลา (ใช้ 1 การเชื่อมต่อ) แล้วบันทึกตำแหน่งเรือลงฐานข้อมูล SQLite
// - มี HTTP API ให้เว็บบน Vercel และ connector ของ Claude มาอ่านตำแหน่งล่าสุดและเส้นทางย้อนหลัง
// รันบนเครื่องที่เปิดตลอด (เซิร์ฟเวอร์บริษัท, VPS ฯลฯ) ต้องใช้ Node.js 22.13 ขึ้นไป
//   npm install
//   AISSTREAM_API_KEY=... COLLECTOR_TOKEN=... node collector/collector.mjs
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { mergeInto, normBox, publicVessel, TYPES_SUBSCRIBED } from '../lib/aisstream.js';

const env = process.env;
const cfg = {
  key: String(env.AISSTREAM_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim(),
  token: String(env.COLLECTOR_TOKEN || '').trim(),
  port: Number(env.PORT) || 8787,
  dbPath: env.DB_PATH || new URL('./ais.db', import.meta.url).pathname,
  // พื้นที่ที่จะเก็บ: "south,west,north,east;south,west,north,east" ค่าเริ่มต้นคือเอเชียตะวันออกเฉียงใต้
  boxes: String(env.AIS_BBOXES || '-11,90,25,125').split(';').map(b => b.split(',').map(Number)).filter(b => b.length === 4 && b.every(Number.isFinite)),
  retentionDays: Number(env.RETENTION_DAYS) || 30,
  minIntervalS: Number(env.TRACK_MIN_INTERVAL_S) || 60,   // เก็บจุดเส้นทางห่างกันอย่างน้อยกี่วินาที
  url: env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream',
};
if (!cfg.key) { console.error('❌ ต้องตั้ง AISSTREAM_API_KEY'); process.exit(1); }
if (!cfg.token) { console.error('❌ ต้องตั้ง COLLECTOR_TOKEN (รหัสยาวๆ ที่คิดขึ้นเอง ใช้กันคนอื่นเรียก API)'); process.exit(1); }
if (!cfg.boxes.length) { console.error('❌ AIS_BBOXES ไม่ถูกต้อง'); process.exit(1); }

// ---------------- ฐานข้อมูล ----------------
const db = new DatabaseSync(cfg.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS vessels (mmsi INTEGER PRIMARY KEY, data TEXT NOT NULL, lat REAL, lon REAL, t INTEGER);
  CREATE INDEX IF NOT EXISTS vessels_t ON vessels(t);
  CREATE TABLE IF NOT EXISTS track (mmsi INTEGER NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, sog REAL, cog REAL,
    PRIMARY KEY (mmsi, t)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS track_t ON track(t);
`);
const qUpsert = db.prepare('INSERT INTO vessels (mmsi, data, lat, lon, t) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mmsi) DO UPDATE SET data = excluded.data, lat = excluded.lat, lon = excluded.lon, t = excluded.t');
const qPoint = db.prepare('INSERT OR IGNORE INTO track (mmsi, t, lat, lon, sog, cog) VALUES (?, ?, ?, ?, ?, ?)');
const qTrack = db.prepare('SELECT t, lat, lon, sog, cog FROM track WHERE mmsi = ? AND t >= ? ORDER BY t LIMIT 50000');
const qVessel = db.prepare('SELECT data FROM vessels WHERE mmsi = ?');

// เรือทั้งหมดในหน่วยความจำ (โหลดของเดิมจากฐานข้อมูลตอนเริ่ม)
const mem = new Map();
for (const row of db.prepare('SELECT data FROM vessels WHERE t >= ?').all(Date.now() - cfg.retentionDays * 864e5)) {
  try { const v = JSON.parse(row.data); mem.set(v.mmsi, v); } catch {}
}
const lastPoint = new Map();   // mmsi -> จุดล่าสุดที่บันทึก (ใช้ลดจำนวนจุด)
for (const r of db.prepare('SELECT mmsi, MAX(t) AS t, lat, lon, cog FROM track GROUP BY mmsi').all()) lastPoint.set(r.mmsi, r);

const dirty = new Set(), pending = [];
const kmBetween = (a, b, c, d) => { const R = Math.PI / 180, h = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(h))); };

// บันทึกจุดเส้นทางเมื่อ: ผ่านไปอย่างน้อย minIntervalS และเรือขยับ ≥ 30 ม. หรือเปลี่ยนทิศ ≥ 15° หรือครบ 10 นาที
function maybePoint(v) {
  if (v.lat == null || !v.t) return;
  const p = lastPoint.get(v.mmsi), dt = p ? (v.t - p.t) / 1000 : Infinity;
  if (dt < cfg.minIntervalS) return;
  const moved = p ? kmBetween(p.lat, p.lon, v.lat, v.lon) * 1000 : Infinity;
  const turn = p && v.cog != null && p.cog != null ? Math.abs(((v.cog - p.cog + 540) % 360) - 180) : 0;
  if (p && moved < 30 && turn < 15 && dt < 600) return;
  const pt = { mmsi: v.mmsi, t: v.t, lat: v.lat, lon: v.lon, sog: v.sog ?? null, cog: v.cog ?? null };
  lastPoint.set(v.mmsi, pt); pending.push(pt);
}
function flush() {
  if (!dirty.size && !pending.length) return;
  const n = pending.length;
  try {
    db.exec('BEGIN');
    for (const m of dirty) { const v = mem.get(m); if (v) qUpsert.run(m, JSON.stringify(v), v.lat ?? null, v.lon ?? null, v.t || v.ts || Date.now()); }
    for (const p of pending) qPoint.run(p.mmsi, p.t, p.lat, p.lon, p.sog, p.cog);
    db.exec('COMMIT');
    stats.pointsWritten += n;
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('DB error', e.message); }
  dirty.clear(); pending.length = 0;
}
setInterval(flush, 5000);
function prune() {
  const cutoff = Date.now() - cfg.retentionDays * 864e5;
  db.prepare('DELETE FROM track WHERE t < ?').run(cutoff);
  db.prepare('DELETE FROM vessels WHERE t < ?').run(cutoff);
  for (const [k, v] of mem) if ((v.t || v.ts || 0) < cutoff) mem.delete(k);
}
setInterval(prune, 3600e3); prune();

// ---------------- การเชื่อมต่อ AISStream (ต่อใหม่อัตโนมัติ) ----------------
const stats = { startedAt: Date.now(), connected: false, messages: 0, lastMessageAt: null, reconnects: 0, pointsWritten: 0, lastError: null };
let backoff = 5000;
function connect() {
  const ws = new WebSocket(cfg.url, { perMessageDeflate: true, handshakeTimeout: 20000 });
  let confirmed = false, errored = false;
  ws.on('open', () => ws.send(JSON.stringify({ APIKey: cfg.key, BoundingBoxes: cfg.boxes.map(([s, w, n, e]) => normBox(s, w, n, e)).flat(), FilterMessageTypes: TYPES_SUBSCRIBED })));
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.MessageType === 'SubscriptionConfirmation') { confirmed = true; return; }
    if (msg.error) { stats.lastError = msg.error; return; }
    if (!confirmed) { confirmed = true; }
    if (!stats.connected) { stats.connected = true; backoff = 5000; console.log('✅ เชื่อมต่อ AISStream แล้ว กำลังเก็บข้อมูล'); }
    stats.messages++; stats.lastMessageAt = Date.now();
    const v = mergeInto(mem, msg);
    if (!v) return;
    dirty.add(v.mmsi);
    if (msg.MessageType.endsWith('PositionReport')) maybePoint(v);
  });
  ws.on('close', (code, reason) => {
    stats.connected = false;
    if (!confirmed && !errored) stats.lastError = `closed before confirmation (code ${code}${reason?.length ? ', ' + reason : ''}) — key ไม่ถูกต้อง หรือมีการเชื่อมต่อเกิน 3 ช่องทาง`;
    console.warn(`⚠️  AISStream ปิดการเชื่อมต่อ (code ${code}) จะต่อใหม่ใน ${backoff / 1000} วินาที`);
    stats.reconnects++;
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 300000);
  });
  ws.on('error', e => { errored = true; stats.lastError = e.message; });
  // ถ้าเงียบนานผิดปกติ ให้ต่อใหม่
  const watchdog = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && stats.lastMessageAt && Date.now() - stats.lastMessageAt > 300000) { console.warn('ไม่มีข้อมูล 5 นาที ต่อใหม่'); ws.terminate(); }
  }, 60000);
  ws.on('close', () => clearInterval(watchdog));
}
connect();

// ---------------- HTTP API ----------------
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const publicStats = () => ({ connected: stats.connected, vessels: mem.size, messages: stats.messages,
  lastMessageAgeS: stats.lastMessageAt ? Math.round((Date.now() - stats.lastMessageAt) / 1000) : null,
  pointsWritten: stats.pointsWritten, reconnects: stats.reconnects, lastError: stats.lastError,
  uptimeH: Math.round((Date.now() - stats.startedAt) / 36e5 * 10) / 10, boxes: cfg.boxes, retentionDays: cfg.retentionDays });

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local'), q = url.searchParams;
  if (url.pathname === '/health') return json(res, 200, { ok: true, connected: stats.connected });
  if (req.headers.authorization !== `Bearer ${cfg.token}`) return json(res, 401, { error: 'unauthorized' });
  try {
    if (url.pathname === '/stats') return json(res, 200, publicStats());
    if (url.pathname === '/ships') {
      const [s, w, n, e] = (q.get('bbox') || '').split(',').map(Number);
      if (![s, w, n, e].every(Number.isFinite)) return json(res, 400, { error: 'bbox=south,west,north,east required' });
      const boxes = normBox(s, w, n, e), maxAge = (Number(q.get('maxAgeMin')) || 60) * 60000, limit = Math.min(20000, Number(q.get('limit')) || 8000);
      const now = Date.now(), out = [];
      for (const v of mem.values()) {
        if (v.lat == null || now - (v.t || 0) > maxAge) continue;
        if (!boxes.some(([[a, b], [c, d]]) => v.lat >= a && v.lat <= c && v.lon >= b && v.lon <= d)) continue;
        out.push(v);
      }
      out.sort((a, b) => b.t - a.t);
      return json(res, 200, { count: out.length, vessels: out.slice(0, limit).map(publicVessel), stats: publicStats() });
    }
    if (url.pathname === '/ship') {
      const m = Number(q.get('mmsi'));
      let v = mem.get(m);
      if (!v) { const row = qVessel.get(m); if (row) v = JSON.parse(row.data); }
      return v && v.lat != null ? json(res, 200, { vessel: publicVessel(v) }) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/track') {
      const m = Number(q.get('mmsi')), hours = Math.min(cfg.retentionDays * 24, Math.max(0.1, Number(q.get('hours')) || 24));
      const pts = qTrack.all(m, Date.now() - hours * 36e5);
      return json(res, 200, { mmsi: m, hours, count: pts.length, points: pts.map(p => [p.t, p.lat, p.lon, p.sog, p.cog]) });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: e.message }); }
}).listen(cfg.port, () => {
  console.log(`🚢 collector เปิดที่ http://localhost:${cfg.port}  ฐานข้อมูล ${cfg.dbPath}`);
  console.log(`   พื้นที่: ${cfg.boxes.map(b => b.join(',')).join(' ; ')}  เก็บย้อนหลัง ${cfg.retentionDays} วัน`);
});

const stop = () => { flush(); db.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
