// orbit-core.js — คำนวณวงโคจร ใช้ร่วมกันทั้งหน้าเว็บ (browser) และ MCP server (Node)
// ทุกฟังก์ชันรับไลบรารี satellite.js เป็นพารามิเตอร์ตัวแรก (sat) เพื่อให้ใช้ได้ทั้งสองฝั่ง

export const GROUPS = [
  { id: 'stations',     name: 'สถานีอวกาศ',        en: 'Space stations (ISS, Tiangong)', color: '#C92A2A', size: 5, on: true },
  { id: 'gps-ops',      name: 'GPS',               en: 'GPS (USA)',                      color: '#5F3DC4', size: 3.5, on: true },
  { id: 'galileo',      name: 'Galileo',           en: 'Galileo (EU)',                   color: '#1864AB', size: 3.5, on: false },
  { id: 'glo-ops',      name: 'GLONASS',           en: 'GLONASS (Russia)',               color: '#2B8A3E', size: 3.5, on: false },
  { id: 'beidou',       name: 'BeiDou',            en: 'BeiDou (China)',                 color: '#E67700', size: 3.5, on: false },
  { id: 'oneweb',       name: 'OneWeb',            en: 'OneWeb internet',                color: '#0B7285', size: 2.2, on: true },
  { id: 'starlink',     name: 'Starlink',          en: 'Starlink internet',              color: '#364FC7', size: 1.4, on: false },
  { id: 'kuiper',       name: 'Kuiper',            en: 'Amazon Kuiper internet',         color: '#A61E4D', size: 2.2, on: false },
  { id: 'qianfan',      name: 'Qianfan',           en: 'Qianfan / Thousand Sails',       color: '#9C36B5', size: 2.2, on: false },
  { id: 'iridium-NEXT', name: 'Iridium NEXT',      en: 'Iridium NEXT',                   color: '#5C940D', size: 2.6, on: false },
  { id: 'weather',      name: 'ดาวเทียมอุตุนิยมฯ',   en: 'Weather satellites',             color: '#1098AD', size: 3, on: false },
  { id: 'geo',          name: 'วงโคจรค้างฟ้า (GEO)', en: 'Geostationary',                  color: '#495057', size: 2.6, on: false },
  { id: 'amateur',      name: 'วิทยุสมัครเล่น',      en: 'Amateur radio',                  color: '#D6336C', size: 2.6, on: false },
];

export const GROUP_IDS = GROUPS.map(g => g.id);

// ข้อมูล OMM ส่งแบบย่อเป็นแถว เพื่อให้ Starlink (~11,000 ดวง) มีขนาดเล็กพอ
export const FIELDS = ['OBJECT_NAME', 'NORAD_CAT_ID', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY',
  'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

export const packOMM = list => list.map(o => FIELDS.map(f => o[f]));
export const unpackRow = row => Object.fromEntries(FIELDS.map((f, i) => [f, row[i]]));

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function makeRecord(sat, omm) {
  try {
    const rec = sat.json2satrec(omm);
    if (!rec || rec.error) return null;
    return {
      name: String(omm.OBJECT_NAME).trim(),
      norad: Number(omm.NORAD_CAT_ID),
      intl: omm.OBJECT_ID || '',
      epoch: omm.EPOCH,
      periodMin: 1440 / Number(omm.MEAN_MOTION),
      rec,
    };
  } catch { return null; }
}

function propagateEci(sat, r, date) {
  const pv = sat.propagate(r.rec, date);
  if (!pv || !pv.position || typeof pv.position !== 'object') return null;
  if (!Number.isFinite(pv.position.x)) return null;
  return pv;
}

export function positionAt(sat, r, date) {
  const pv = propagateEci(sat, r, date);
  if (!pv) return null;
  const g = sat.eciToGeodetic(pv.position, sat.gstime(date));
  const v = pv.velocity;
  return {
    lat: sat.degreesLat(g.latitude),
    lon: sat.degreesLong(g.longitude),
    alt: g.height,
    speed: Math.hypot(v.x, v.y, v.z),
  };
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

const TH8 = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
const EN8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassTh = deg => TH8[Math.round(deg / 45) % 8];
export const compassEn = deg => EN8[Math.round(deg / 45) % 8];

// ตำแหน่ง + ทิศที่กำลังเคลื่อนที่ (เทียบตำแหน่งตอนนี้กับอีก 10 วินาทีข้างหน้า)
export function motionAt(sat, r, date) {
  const a = positionAt(sat, r, date);
  const b = positionAt(sat, r, new Date(date.getTime() + 10000));
  if (!a || !b) return null;
  const heading = bearing(a.lat, a.lon, b.lat, b.lon);
  return { ...a, heading, headingTh: compassTh(heading), headingEn: compassEn(heading), northbound: b.lat >= a.lat };
}

// เส้นทางภาคพื้นดิน (ground track)
export function groundTrack(sat, r, start, minutes, stepMin) {
  const pts = [];
  for (let m = 0; m <= minutes; m += stepMin) {
    const t = new Date(start.getTime() + m * 60000);
    const p = positionAt(sat, r, t);
    if (p) pts.push({ time: t, lat: p.lat, lon: p.lon, alt: p.alt });
  }
  return pts;
}

// มุมเงย/มุมทิศของดาวเทียมเมื่อมองจากผู้สังเกต
export function lookAt(sat, r, obs, date) {
  const pv = propagateEci(sat, r, date);
  if (!pv) return null;
  const ecf = sat.eciToEcf(pv.position, sat.gstime(date));
  const la = sat.ecfToLookAngles(
    { latitude: obs.lat * D2R, longitude: obs.lon * D2R, height: (obs.heightKm || 0) }, ecf);
  return { az: (la.azimuth * R2D + 360) % 360, el: la.elevation * R2D, rangeKm: la.rangeSat };
}

// ทำนายช่วงเวลาที่ดาวเทียมผ่านเหนือผู้สังเกต
export function predictPasses(sat, r, obs, start, hours = 24, minEl = 10, maxPasses = 10) {
  const elAt = t => { const l = lookAt(sat, r, obs, new Date(t)); return l ? l.el : -90; };
  const refine = (lo, hi, rising) => {
    for (let i = 0; i < 20 && hi - lo > 500; i++) {
      const mid = (lo + hi) / 2;
      if ((elAt(mid) >= minEl) === rising) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const step = r.periodMin > 600 ? 300000 : 20000;
  const t0 = start.getTime(), tEnd = t0 + hours * 3600000;
  const passes = [];
  let prevT = t0, prevUp = elAt(t0) >= minEl;
  let cur = prevUp ? { rise: t0, max: -90, maxT: t0, risingCut: true } : null;
  for (let t = t0 + step; t <= tEnd && passes.length < maxPasses; t += step) {
    const el = elAt(t), up = el >= minEl;
    if (up && !prevUp) cur = { rise: refine(prevT, t, true), max: -90, maxT: t };
    if (up && cur && el > cur.max) { cur.max = el; cur.maxT = t; }
    if (!up && prevUp && cur) { cur.set = refine(prevT, t, false); passes.push(cur); cur = null; }
    prevT = t; prevUp = up;
  }
  if (cur) { cur.set = tEnd; cur.setCut = true; passes.push(cur); }
  return passes.map(p => {
    const a = lookAt(sat, r, obs, new Date(p.rise)), m = lookAt(sat, r, obs, new Date(p.maxT)), s = lookAt(sat, r, obs, new Date(p.set));
    return {
      rise: new Date(p.rise), set: new Date(p.set), max: new Date(p.maxT),
      maxElevation: m ? m.el : p.max,
      riseAz: a ? a.az : null, setAz: s ? s.az : null,
      durationMin: (p.set - p.rise) / 60000,
      alreadyUp: !!p.risingCut, cutAtEnd: !!p.setCut,
    };
  });
}

// มุม AZ/EL จากตำแหน่งที่คำนวณไว้แล้ว (เร็วกว่า lookAt เพราะไม่ต้อง propagate ใหม่)
export function lookFromPos(sat, obs, p) {
  const ecf = sat.geodeticToEcf({ latitude: p.lat * D2R, longitude: p.lon * D2R, height: p.alt });
  const la = sat.ecfToLookAngles({ latitude: obs.lat * D2R, longitude: obs.lon * D2R, height: obs.heightKm || 0 }, ecf);
  return { az: (la.azimuth * R2D + 360) % 360, el: la.elevation * R2D, rangeKm: la.rangeSat };
}

// พื้นที่ครอบคลุม (footprint): มุมที่ศูนย์กลางโลก (องศา) และรัศมีบนพื้นโลก (กม.)
// ที่ผู้ใช้บนพื้นเห็นดาวเทียมสูงกว่ามุมเงยต่ำสุด minElDeg
export const EARTH_R = 6371;
export function coverage(altKm, minElDeg) {
  const e = minElDeg * D2R;
  const lam = Math.acos((EARTH_R / (EARTH_R + altKm)) * Math.cos(e)) - e;
  const l = Math.max(0, lam);
  return { angleDeg: l * R2D, radiusKm: l * EARTH_R };
}
