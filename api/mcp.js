// POST /mcp — MCP server แบบ Streamable HTTP (stateless) ให้ Claude เชื่อมต่อเป็น custom connector
import { GROUPS, getGroupRecords, getByNorad, searchByName, satellite } from '../lib/celestrak.js';
import { motionAt, groundTrack, predictPasses, compassTh, compassEn } from '../public/orbit-core.js';

const SERVER = { name: 'sattrack', version: '1.0.0' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Satellite tracker using CelesTrak orbital data (OMM/TLE) and SGP4 propagation. ' +
  'Positions are computed, not observed; accuracy is a few km for recent element sets. ' +
  'Use list_constellations to see group ids, get_positions for where a whole system is, ' +
  'get_satellite / get_ground_track for one object, predict_passes for when it flies over a place.';

const timeProp = { type: 'string', description: 'ISO 8601 time, e.g. 2026-11-16T12:00:00Z. Defaults to now.' };
const tzProp = { type: 'string', description: 'Optional IANA timezone for local times in the output, e.g. Asia/Bangkok.' };

const TOOLS = [
  {
    name: 'list_constellations',
    description: 'List the satellite systems (constellation groups) this server can track, with their ids.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_positions',
    description: 'Positions and direction of travel for satellites in one constellation at a given time: latitude, longitude, altitude, speed, compass heading. Optionally only those near a point on Earth.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: GROUPS.map(g => g.id), description: 'Constellation id from list_constellations.' },
        time: timeProp,
        name_contains: { type: 'string', description: 'Optional filter on satellite name, e.g. "PRN 05".' },
        near_latitude: { type: 'number', description: 'Optional: only satellites whose ground point is within radius_km of this latitude/longitude.' },
        near_longitude: { type: 'number' },
        radius_km: { type: 'number', description: 'Radius for the near filter. Default 1000.' },
        limit: { type: 'integer', description: 'Max satellites to return (1-200). Default 25.' },
        timezone: tzProp,
      },
      required: ['group'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_satellite',
    description: 'Look up one satellite by NORAD catalog id or by name and return where it is and which way it is moving, plus orbit info.',
    inputSchema: {
      type: 'object',
      properties: {
        norad_id: { type: 'integer', description: 'NORAD catalog number, e.g. 25544 for the ISS.' },
        name: { type: 'string', description: 'Name search if the id is unknown, e.g. "THAICHOTE" or "ISS".' },
        time: timeProp,
        timezone: tzProp,
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_ground_track',
    description: 'The path over the ground a satellite will follow (or followed) over a time window, as timed latitude/longitude points.',
    inputSchema: {
      type: 'object',
      properties: {
        norad_id: { type: 'integer' },
        start_time: timeProp,
        duration_minutes: { type: 'number', description: 'Window length, 1-1440. Default: one orbit.' },
        step_minutes: { type: 'number', description: 'Spacing between points. Default 5.' },
        timezone: tzProp,
      },
      required: ['norad_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'predict_passes',
    description: 'When a satellite will pass over a location: rise, highest point and set times, with the compass direction it appears from and disappears toward.',
    inputSchema: {
      type: 'object',
      properties: {
        norad_id: { type: 'integer' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        start_time: timeProp,
        hours: { type: 'number', description: 'How far ahead to search, 1-72. Default 24.' },
        min_elevation: { type: 'number', description: 'Minimum elevation above the horizon in degrees. Default 10.' },
        timezone: tzProp,
      },
      required: ['norad_id', 'latitude', 'longitude'],
    },
    annotations: { readOnlyHint: true },
  },
];

// ---------- helpers ----------
const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);

function parseTime(s) {
  if (s === undefined || s === null || s === '') return new Date();
  const d = new Date(s);
  if (isNaN(d)) throw new Error(`Invalid time "${s}". Use ISO 8601, e.g. 2026-11-16T12:00:00Z`);
  return d;
}

function fmtTime(d, tz) {
  const out = { utc: d.toISOString().replace(/\.\d+Z$/, 'Z') };
  if (tz) {
    try {
      out.local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(d);
      out.timezone = tz;
    } catch { out.timezone_error = `Unknown timezone "${tz}"`; }
  }
  return out;
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const R = 6371, D = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * D / 2) ** 2 +
    Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin((lon2 - lon1) * D / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function describe(r, m) {
  return {
    name: r.name,
    norad_id: r.norad,
    latitude: r3(m.lat),
    longitude: r3(m.lon),
    altitude_km: r1(m.alt),
    speed_km_s: r3(m.speed),
    heading_deg: r1(m.heading),
    heading: m.headingEn,
    heading_th: `ทิศ${m.headingTh}`,
    moving: m.northbound ? 'northbound (ขึ้นเหนือ)' : 'southbound (ลงใต้)',
  };
}

async function requireSat(norad) {
  const r = await getByNorad(norad);
  if (!r) throw new Error(`No orbital data found for NORAD ${norad}. It may have decayed or the id is wrong.`);
  return r;
}

// ---------- tools ----------
const handlers = {
  async list_constellations() {
    return { constellations: GROUPS.map(g => ({ id: g.id, name: g.en, name_th: g.name })), source: 'CelesTrak' };
  },

  async get_positions(a) {
    const t = parseTime(a.time);
    const recs = await getGroupRecords(a.group);
    const limit = clamp(a.limit, 1, 200, 25);
    const needle = a.name_contains ? String(a.name_contains).toUpperCase() : null;
    const near = Number.isFinite(a.near_latitude) && Number.isFinite(a.near_longitude);
    const radius = clamp(a.radius_km, 1, 20000, 1000);
    let rows = [];
    for (const r of recs) {
      if (needle && !r.name.toUpperCase().includes(needle)) continue;
      const m = motionAt(satellite, r, t);
      if (!m) continue;
      const row = describe(r, m);
      if (near) {
        const d = kmBetween(a.near_latitude, a.near_longitude, m.lat, m.lon);
        if (d > radius) continue;
        row.distance_km = Math.round(d);
      }
      rows.push(row);
    }
    if (near) rows.sort((x, y) => x.distance_km - y.distance_km);
    const matched = rows.length;
    return {
      group: a.group, time: fmtTime(t, a.timezone),
      total_in_group: recs.length, matched, returned: Math.min(limit, matched),
      satellites: rows.slice(0, limit),
      note: matched > limit ? `Showing ${limit} of ${matched}. Narrow with name_contains or near_latitude/near_longitude, or raise limit.` : undefined,
    };
  },

  async get_satellite(a) {
    const t = parseTime(a.time);
    let r;
    if (a.norad_id) r = await requireSat(a.norad_id);
    else if (a.name) {
      const found = await searchByName(a.name);
      if (!found.length) throw new Error(`No satellite matches "${a.name}".`);
      if (found.length > 1) {
        return { matches: found.slice(0, 30).map(x => ({ name: x.name, norad_id: x.norad })),
          note: 'Several satellites match. Call again with norad_id.' };
      }
      r = found[0];
    } else throw new Error('Give norad_id or name.');
    const m = motionAt(satellite, r, t);
    if (!m) throw new Error('Propagation failed; the element set may be too old.');
    return {
      time: fmtTime(t, a.timezone),
      ...describe(r, m),
      international_designator: r.intl,
      orbit: {
        period_min: r1(r.periodMin),
        inclination_deg: r1(r.rec.inclo * 180 / Math.PI),
        element_set_epoch: r.epoch,
      },
    };
  },

  async get_ground_track(a) {
    const r = await requireSat(a.norad_id);
    const start = parseTime(a.start_time);
    const dur = clamp(a.duration_minutes, 1, 1440, Math.round(r.periodMin));
    const step = clamp(a.step_minutes, 0.5, 120, 5);
    if (dur / step > 500) throw new Error('Too many points; raise step_minutes (max 500 points).');
    const pts = groundTrack(satellite, r, start, dur, step).map(p => ({
      ...fmtTime(p.time, a.timezone), latitude: r3(p.lat), longitude: r3(p.lon), altitude_km: r1(p.alt),
    }));
    return { name: r.name, norad_id: r.norad, period_min: r1(r.periodMin), points: pts };
  },

  async predict_passes(a) {
    const r = await requireSat(a.norad_id);
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) throw new Error('latitude and longitude are required numbers');
    const start = parseTime(a.start_time);
    const hours = clamp(a.hours, 1, 72, 24), minEl = clamp(a.min_elevation, 0, 89, 10);
    if (r.periodMin > 1300 && r.periodMin < 1580) {
      return { name: r.name, norad_id: r.norad, note: 'Geostationary/geosynchronous satellite: it stays at a nearly fixed point in the sky and does not make passes.' };
    }
    const passes = predictPasses(satellite, r, { lat: a.latitude, lon: a.longitude }, start, hours, minEl).map(p => ({
      rise: { ...fmtTime(p.rise, a.timezone), from: p.riseAz == null ? null : `${compassEn(p.riseAz)} (ทิศ${compassTh(p.riseAz)}) ${r1(p.riseAz)}°` },
      highest: { ...fmtTime(p.max, a.timezone), elevation_deg: r1(p.maxElevation) },
      set: { ...fmtTime(p.set, a.timezone), toward: p.setAz == null ? null : `${compassEn(p.setAz)} (ทิศ${compassTh(p.setAz)}) ${r1(p.setAz)}°` },
      duration_min: r1(p.durationMin),
      ...(p.alreadyUp ? { note_start: 'Already above the minimum elevation at the start time' } : {}),
      ...(p.cutAtEnd ? { note_end: 'Still up at the end of the search window' } : {}),
    }));
    return {
      name: r.name, norad_id: r.norad,
      observer: { latitude: a.latitude, longitude: a.longitude },
      window_hours: hours, min_elevation_deg: minEl,
      passes, note: passes.length ? undefined : 'No passes above the minimum elevation in this window.',
    };
  },
};

// ---------- JSON-RPC ----------
async function handleMessage(msg) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid Request');
  if (isNotification) return null; // เช่น notifications/initialized

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const fn = handlers[params.name];
      if (!fn) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        const data = await fn(params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data });
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') {
    // ไม่มี SSE stream แยก (stateless) — ตามสเปกให้ตอบ 405
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('This MCP endpoint accepts POST only.');
  }

  let body;
  try { body = await readBody(req); } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }

  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleMessage))).filter(Boolean);
  if (!replies.length) { res.statusCode = 202; return res.end(); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(batch ? replies : replies[0]));
}
