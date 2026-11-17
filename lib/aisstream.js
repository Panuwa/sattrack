// ดึงข้อมูลเรือจาก AISStream (wss://stream.aisstream.io) ฝั่งเซิร์ฟเวอร์
// - API key อยู่ใน Environment Variable ชื่อ AISSTREAM_API_KEY เท่านั้น (AISStream ไม่อนุญาตให้เบราว์เซอร์ต่อตรง)
// - AISStream เป็นแบบ stream ไม่มี REST เราจึงเปิดการเชื่อมต่อสั้นๆ ฟังข้อความช่วงหนึ่ง แล้วสรุปเป็นรายการเรือ
// - จำกัด 3 การเชื่อมต่อพร้อมกันต่อบัญชี จึงรวมคำขอที่ซ้ำกันและแคชผลไว้
import WebSocket from 'ws';

const STREAM_URL = process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream';
const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const MAX_AGE_MS = 30 * 60 * 1000;     // เก็บเรือที่เห็นล่าสุดภายใน 30 นาที
const MAX_STORE = 60000;

const vessels = new Map();             // mmsi -> ข้อมูลเรือ (แคชในเครื่องเซิร์ฟเวอร์ที่ยังทำงานอยู่)
const inflight = new Map();            // คำขอที่กำลังทำงาน (รวมคำขอซ้ำ)

export const hasKey = () => !!process.env.AISSTREAM_API_KEY;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v.replace(/@+$/g, '').trim() || null : null);
const validPos = (lat, lon) => lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

function merge(msg) {
  const type = msg.MessageType, body = msg.Message?.[type], meta = msg.MetaData || {};
  const mmsi = Number(meta.MMSI ?? body?.UserID);
  if (!body || !Number.isInteger(mmsi) || mmsi <= 0) return null;
  const v = vessels.get(mmsi) || { mmsi };
  const name = str(meta.ShipName);
  if (name) v.name = name;
  if (type === 'PositionReport' || type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
    const lat = num(body.Latitude) ?? num(meta.Latitude ?? meta.latitude);
    const lon = num(body.Longitude) ?? num(meta.Longitude ?? meta.longitude);
    if (!validPos(lat, lon)) return null;
    v.lat = lat; v.lon = lon;
    const sog = num(body.Sog); v.sog = sog !== null && sog < 102.3 ? sog : null;
    const cog = num(body.Cog); v.cog = cog !== null && cog < 360 ? cog : null;
    const hdg = num(body.TrueHeading); v.hdg = hdg !== null && hdg < 360 ? hdg : null;
    if (type === 'PositionReport') { v.nav = num(body.NavigationalStatus); v.cls = 'A'; } else v.cls = 'B';
    if (type === 'ExtendedClassBPositionReport') {
      const n = str(body.Name); if (n) v.name = n;
      if (num(body.Type)) v.type = body.Type;
    }
    v.t = Date.now();
  } else if (type === 'ShipStaticData') {
    const n = str(body.Name); if (n) v.name = n;
    v.callsign = str(body.CallSign) || v.callsign;
    if (num(body.ImoNumber)) v.imo = body.ImoNumber;
    if (num(body.Type)) v.type = body.Type;
    v.dest = str(body.Destination) || v.dest;
    const d = body.Dimension;
    if (d && (d.A + d.B) > 0) { v.len = d.A + d.B; v.beam = d.C + d.D; }
    if (num(body.MaximumStaticDraught)) v.draught = body.MaximumStaticDraught;
    const e = body.Eta;
    if (e && e.Month >= 1 && e.Month <= 12 && e.Day >= 1) v.eta = { month: e.Month, day: e.Day, hour: e.Hour, minute: e.Minute };
    v.ts = Date.now();
  } else if (type === 'StaticDataReport') {
    const n = str(body.ReportA?.Name); if (n) v.name = n;
    const b = body.ReportB;
    if (b?.Valid) {
      v.callsign = str(b.CallSign) || v.callsign;
      if (num(b.ShipType)) v.type = b.ShipType;
      const d = b.Dimension;
      if (d && (d.A + d.B) > 0) { v.len = d.A + d.B; v.beam = d.C + d.D; }
    }
    v.ts = Date.now();
  } else return null;
  vessels.set(mmsi, v);
  return v;
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of vessels) if ((v.t || 0) < cutoff && (v.ts || 0) < cutoff) vessels.delete(k);
  if (vessels.size > MAX_STORE) {
    const old = [...vessels.values()].sort((a, b) => (a.t || 0) - (b.t || 0)).slice(0, vessels.size - MAX_STORE);
    old.forEach(v => vessels.delete(v.mmsi));
  }
}

// เปิดการเชื่อมต่อ ฟังข้อความ seconds วินาที (นับหลังได้รับการยืนยัน subscription)
function listen({ boxes, mmsis, seconds, stopWhen }) {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return Promise.reject(Object.assign(new Error('AISSTREAM_API_KEY is not set on the server'), { code: 'NO_KEY' }));
  return new Promise((resolve, reject) => {
    let confirmed = false, count = 0, done = false, timer = null;
    const ws = new WebSocket(STREAM_URL, { perMessageDeflate: true, handshakeTimeout: 15000 });
    const finish = err => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(hard);
      try { ws.terminate(); } catch {}
      if (err && !count) reject(err); else resolve({ messages: count, confirmed });
    };
    // เผื่อเวลา handshake ที่อาจช้าหลายวินาที
    const hard = setTimeout(() => finish(confirmed ? null : new Error('AISStream did not confirm the subscription in time')), (seconds + 20) * 1000);
    ws.on('open', () => {
      const sub = { APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: TYPES };
      if (mmsis?.length) sub.FiltersShipMMSI = mmsis.map(m => String(m).padStart(9, '0'));
      ws.send(JSON.stringify(sub));
    });
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
      if (msg.MessageType === 'SubscriptionConfirmation') {
        if (!confirmed) { confirmed = true; timer = setTimeout(() => finish(null), seconds * 1000); }
        return;
      }
      if (msg.error) return finish(new Error(`AISStream: ${msg.error}`));
      if (!confirmed) { confirmed = true; timer = setTimeout(() => finish(null), seconds * 1000); }
      if (merge(msg)) count++;
      if (stopWhen && stopWhen()) finish(null);
    });
    ws.on('error', e => finish(new Error(`AISStream connection error: ${e.message}`)));
    ws.on('close', () => finish(confirmed ? null
      : Object.assign(new Error('AISStream closed the connection: the API key may be invalid, or the 3-connection limit was reached'), { code: 'REJECTED' })));
  });
}

// แปลงกรอบพื้นที่ (south, west, north, east) เป็นรูปแบบของ AISStream โดยปัดออกเป็นจำนวนเต็มองศา
export function normBox(s, w, n, e) {
  const S = Math.max(-90, Math.floor(Math.min(s, n))), N = Math.min(90, Math.ceil(Math.max(s, n)));
  const wrap = x => ((x + 540) % 360 + 360) % 360 - 180;
  let W = Math.floor(wrap(w)), E = Math.ceil(wrap(e));
  if (e - w >= 359) { W = -180; E = 180; }
  if (W < E) return [[[S, W], [N, E]]];
  return [[[S, W], [N, 180]], [[S, -180], [N, E]]];   // ข้ามเส้นแบ่งวันสากล
}

const inBoxes = (v, boxes) => boxes.some(([[s, w], [n, e]]) => v.lat >= s && v.lat <= n && v.lon >= w && v.lon <= e);

export function publicVessel(v) {
  const o = { mmsi: v.mmsi, name: v.name || null, lat: v.lat, lon: v.lon, sog: v.sog ?? null, cog: v.cog ?? null, hdg: v.hdg ?? null,
    nav: v.nav ?? null, type: v.type ?? null, cls: v.cls || null, t: v.t ? new Date(v.t).toISOString() : null };
  for (const k of ['callsign', 'imo', 'dest', 'eta', 'len', 'beam', 'draught']) if (v[k] != null) o[k] = v[k];
  return o;
}

// เรือในพื้นที่: ฟัง seconds วินาที แล้วคืนทุกลำที่รู้ตำแหน่งในพื้นที่นั้น (รวมที่เห็นก่อนหน้าไม่เกิน 30 นาที)
export async function shipsInBoxes(boxes, seconds = 8, limit = 8000) {
  const key = 'B' + JSON.stringify(boxes);
  if (!inflight.has(key)) {
    inflight.set(key, listen({ boxes, seconds }).finally(() => inflight.delete(key)));
  }
  const info = await inflight.get(key);
  prune();
  const list = [...vessels.values()].filter(v => v.lat != null && inBoxes(v, boxes))
    .sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, limit);
  return { ...info, vessels: list };
}

// หาเรือลำเดียวจาก MMSI ทั่วโลก: รอจนได้ตำแหน่ง (เรือที่จอดนิ่งอาจส่งสัญญาณทุก 3 นาที)
export async function findShip(mmsi, seconds = 25) {
  const id = Number(mmsi);
  if (!Number.isInteger(id) || id < 1e6 || id > 999999999) throw new Error('MMSI must be a 9-digit number');
  const key = 'M' + id;
  const startedAt = Date.now();
  if (!inflight.has(key)) {
    inflight.set(key, listen({
      boxes: [[[-90, -180], [90, 180]]], mmsis: [id], seconds,
      stopWhen: () => { const v = vessels.get(id); return !!(v && v.t >= startedAt); },
    }).finally(() => inflight.delete(key)));
  }
  await inflight.get(key);
  const v = vessels.get(id);
  return v && v.lat != null ? v : null;
}

export const SHIP_TYPES = [
  [30, 30, 'fishing'], [31, 32, 'tug'], [33, 34, 'special'], [35, 35, 'military'], [36, 37, 'pleasure'],
  [40, 49, 'highspeed'], [50, 59, 'special'], [60, 69, 'passenger'], [70, 79, 'cargo'], [80, 89, 'tanker'],
];
export const shipCategory = type => {
  if (type === 52) return 'tug';
  const hit = SHIP_TYPES.find(([a, b]) => type >= a && type <= b);
  return hit ? hit[2] : 'other';
};
export const NAV_STATUS = ['under way using engine', 'at anchor', 'not under command', 'restricted manoeuvrability',
  'constrained by draught', 'moored', 'aground', 'engaged in fishing', 'under way sailing', 'reserved', 'reserved',
  'towing astern', 'pushing ahead / towing alongside', 'reserved', 'AIS-SART / MOB / EPIRB active', 'not defined'];
