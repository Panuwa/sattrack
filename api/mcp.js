// POST /mcp — MCP server แบบ Streamable HTTP (stateless) ให้ Claude เชื่อมต่อเป็น custom connector
import { GROUPS, getGroupRecords, getByNorad, searchByName, satellite } from '../lib/celestrak.js';
import { hasKey, normBox, shipsInBoxes, findShip, publicVessel, shipCategory, NAV_STATUS } from '../lib/aisstream.js';
import { hasCollector, collectorGet } from '../lib/collector.js';
import { fmtLat, fmtLon, motionAt, groundTrack, predictPasses, compassTh, compassEn, positionAt, lookFromPos, coverage } from '../public/orbit-core.js';

const SERVER = { name: 'sattrack', version: '1.0.0' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Satellite tracker using CelesTrak orbital data (OMM/TLE) and SGP4 propagation. ' +
  'Positions are computed, not observed; accuracy is a few km for recent element sets. ' +
  'Use list_constellations to see group ids, get_positions for where a whole system is, ' +
  'get_satellite / get_ground_track for one object, predict_passes for when it flies over a place, get_look_angles for azimuth/elevation from a ground point. Ships (AIS): get_ships_in_area, find_ship, get_ship_track (history).';

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
  {
    name: 'get_look_angles',
    description: 'Azimuth (AZ) and elevation (EL) angles and range from a ground location to satellites: either specific NORAD ids, or the highest satellites of one constellation currently above a minimum elevation.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        norad_ids: { type: 'array', items: { type: 'integer' }, description: 'Up to 30 NORAD ids.' },
        group: { type: 'string', enum: GROUPS.map(g => g.id), description: 'Or: a constellation id to list the satellites highest in the sky.' },
        min_elevation: { type: 'number', description: 'For group mode: minimum elevation in degrees. Default 25.' },
        limit: { type: 'integer', description: 'For group mode: max satellites (1-100). Default 20.' },
        time: timeProp,
        timezone: tzProp,
      },
      required: ['latitude', 'longitude'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_ships_in_area',
    description: 'Live ships (AIS from aisstream.io) around a point: name, MMSI, type, speed, course, status, destination, distance and bearing from the point. Listens to the live stream for a few seconds, so ships that transmit rarely (e.g. at anchor) may be missing.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        radius_km: { type: 'number', description: 'Search radius, 1-1000 km. Default 50.' },
        seconds: { type: 'integer', description: 'How long to listen, 3-20 s. Default 10.' },
        ship_type: { type: 'string', enum: ['cargo', 'tanker', 'passenger', 'fishing', 'tug', 'highspeed', 'pleasure', 'military', 'special', 'other'], description: 'Optional filter by ship category.' },
        name_contains: { type: 'string', description: 'Optional filter on ship name.' },
        limit: { type: 'integer', description: 'Max ships (1-200). Default 50.' },
      },
      required: ['latitude', 'longitude'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'find_ship',
    description: 'Find one ship anywhere in the world by its 9-digit MMSI and return its live AIS position and details. Waits up to 25 seconds for the ship to transmit.',
    inputSchema: { type: 'object', properties: { mmsi: { type: 'string', description: '9-digit MMSI, e.g. "567000123".' } }, required: ['mmsi'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_ship_track',
    description: 'Recorded track history (route) of a ship by MMSI from the AIS collector database: timed positions with speed and course, total distance, and a summary. Needs the collector server.',
    inputSchema: {
      type: 'object',
      properties: {
        mmsi: { type: 'string', description: '9-digit MMSI.' },
        hours: { type: 'number', description: 'How far back, 1-720 hours. Default 24.' },
        max_points: { type: 'integer', description: 'Downsample to at most this many points (10-500). Default 100.' },
        timezone: tzProp,
      },
      required: ['mmsi'],
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
    position_text: `${fmtLat(m.lat)}, ${fmtLon(m.lon)}`,
    altitude_km: r1(m.alt),
    orbital_speed_km_s: r3(m.speed),
    ground_speed_km_s: r3(m.groundSpeed),
    ...(m.stationary
      ? { moving: 'almost stationary over the ground (geostationary) / แทบหยุดนิ่งเหนือพื้นโลก' }
      : { heading_deg: r1(m.heading), heading: m.headingEn, heading_th: `ทิศ${m.headingTh}`,
          moving: m.northbound ? 'northbound (ขึ้นเหนือ)' : 'southbound (ลงใต้)' }),
  };
}

async function requireSat(norad) {
  const r = await getByNorad(norad);
  if (!r) throw new Error(`No orbital data found for NORAD ${norad}. It may have decayed or the id is wrong.`);
  return r;
}


function shipRow(v, distKm, lat0, lon0) {
  const p = publicVessel(v);
  const row = {
    name: p.name, mmsi: p.mmsi, imo: p.imo, callsign: p.callsign, category: shipCategory(p.type), ais_type: p.type,
    latitude: r3(p.lat), longitude: r3(p.lon), position_text: `${fmtLat(p.lat)}, ${fmtLon(p.lon)}`,
    speed_knots: p.sog, course_deg: p.cog, heading_deg: p.hdg,
    status: p.nav != null ? NAV_STATUS[p.nav] : null, destination: p.dest, eta_utc: p.eta,
    length_m: p.len, beam_m: p.beam, draught_m: p.draught, last_report_utc: p.t,
  };
  if (distKm != null) {
    row.distance_km = r1(distKm);
    const b = bearingDeg(lat0, lon0, p.lat, p.lon);
    row.bearing_from_center = `${r1(b)}° ${compassEn(b)} (ทิศ${compassTh(b)})`;
  }
  return Object.fromEntries(Object.entries(row).filter(([, x]) => x != null));
}
function bearingDeg(a, b, c, d) {
  const R = Math.PI / 180, y = Math.sin((d - b) * R) * Math.cos(c * R);
  const x = Math.cos(a * R) * Math.sin(c * R) - Math.sin(a * R) * Math.cos(c * R) * Math.cos((d - b) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
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
        coverage_radius_km_at_25deg_elevation: Math.round(coverage(m.alt, 25).radiusKm),
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

  async get_look_angles(a) {
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) throw new Error('latitude and longitude are required numbers');
    const t = parseTime(a.time), obs = { lat: a.latitude, lon: a.longitude };
    const fmt = (r, p) => {
      const l = lookFromPos(satellite, obs, p);
      return { name: r.name, norad_id: r.norad, azimuth_deg: r1(l.az), azimuth: `${compassEn(l.az)} (ทิศ${compassTh(l.az)})`,
        elevation_deg: r1(l.el), above_horizon: l.el > 0, range_km: Math.round(l.rangeKm), altitude_km: r1(p.alt) };
    };
    if (Array.isArray(a.norad_ids) && a.norad_ids.length) {
      const ids = a.norad_ids.slice(0, 30), out = [];
      for (const id of ids) {
        const r = await getByNorad(id);
        const p = r && positionAt(satellite, r, t);
        out.push(p ? fmt(r, p) : { norad_id: id, error: 'no orbital data' });
      }
      return { observer: obs, time: fmtTime(t, a.timezone), satellites: out };
    }
    if (!a.group) throw new Error('Give norad_ids or group.');
    const minEl = clamp(a.min_elevation, -90, 90, 25), limit = clamp(a.limit, 1, 100, 20);
    const rows = [];
    for (const r of await getGroupRecords(a.group)) {
      const p = positionAt(satellite, r, t); if (!p) continue;
      const row = fmt(r, p); if (row.elevation_deg >= minEl) rows.push(row);
    }
    rows.sort((x, y) => y.elevation_deg - x.elevation_deg);
    return { observer: obs, time: fmtTime(t, a.timezone), group: a.group, min_elevation_deg: minEl,
      visible_count: rows.length, satellites: rows.slice(0, limit) };
  },

  async get_ships_in_area(a) {
    if (!hasKey() && !hasCollector()) throw new Error('Ship tracking is not set up on this server (AISSTREAM_API_KEY or collector missing).');
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) throw new Error('latitude and longitude are required numbers');
    const R = clamp(a.radius_km, 1, 1000, 50), seconds = clamp(a.seconds, 3, 20, 10), limit = clamp(a.limit, 1, 200, 50);
    const dLat = R / 111.2, dLon = Math.min(180, R / (111.2 * Math.max(0.05, Math.cos(a.latitude * Math.PI / 180))));
    const boxes = normBox(a.latitude - dLat, a.longitude - dLon, a.latitude + dLat, a.longitude + dLon);
    let out = null, source = 'aisstream.io (live AIS)';
    if (hasCollector()) {
      try {
        const r = await collectorGet('/ships', { bbox: [a.latitude - dLat, a.longitude - dLon, a.latitude + dLat, a.longitude + dLon].join(','), maxAgeMin: 60, limit: 20000 });
        if (r) { out = { vessels: r.vessels.map(v => ({ ...v, t: Date.parse(v.t) })) }; source = 'AIS collector database (positions from the last 60 minutes)'; }
      } catch {}
    }
    if (!out) { if (!hasKey()) throw new Error('Collector unreachable and no AISSTREAM_API_KEY for live data.'); out = await shipsInBoxes(boxes, seconds); }
    const needle = a.name_contains ? String(a.name_contains).toUpperCase() : null;
    const rows = [];
    for (const v of out.vessels) {
      const d = kmBetween(a.latitude, a.longitude, v.lat, v.lon);
      if (d > R) continue;
      const cat = shipCategory(v.type);
      if (a.ship_type && cat !== a.ship_type) continue;
      if (needle && !(v.name || '').toUpperCase().includes(needle)) continue;
      rows.push(shipRow(v, d, a.latitude, a.longitude));
    }
    rows.sort((x, y) => x.distance_km - y.distance_km);
    return { center: { latitude: a.latitude, longitude: a.longitude }, radius_km: R, ...(source.startsWith('aisstream') ? { listened_seconds: seconds } : {}),
      ships_found: rows.length, ships: rows.slice(0, limit), source,
      note: 'Only ships that transmitted during the listening window (or were seen in the last 30 minutes by this server) are listed.' };
  },

  async find_ship(a) {
    if (!hasKey() && !hasCollector()) throw new Error('Ship tracking is not set up on this server (AISSTREAM_API_KEY or collector missing).');
    if (hasCollector()) {
      try {
        const r = await collectorGet('/ship', { mmsi: String(a.mmsi || '').trim() });
        if (r?.vessel) return { found: true, ...shipRow({ ...r.vessel, t: Date.parse(r.vessel.t) }), source: 'AIS collector database' };
      } catch {}
      if (!hasKey()) return { mmsi: a.mmsi, found: false, note: 'Not in the collector database (outside its area, or not heard yet).' };
    }
    const v = await findShip(String(a.mmsi || '').trim(), 25);
    if (!v) return { mmsi: a.mmsi, found: false, note: 'No position received in 25 seconds. The ship may be out of AIS coverage or transmits rarely (at anchor: every 3 minutes). Try again.' };
    return { found: true, ...shipRow(v), source: 'aisstream.io (live AIS)' };
  },

  async get_ship_track(a) {
    if (!hasCollector()) throw new Error('Track history needs the AIS collector server (COLLECTOR_URL + COLLECTOR_TOKEN). Only live positions are available on this deployment.');
    const mmsi = Number(String(a.mmsi || '').trim()), hours = clamp(a.hours, 1, 720, 24), maxPts = clamp(a.max_points, 10, 500, 100);
    if (!Number.isInteger(mmsi) || mmsi <= 0) throw new Error('mmsi must be a 9-digit number');
    const r = await collectorGet('/track', { mmsi, hours });
    const pts = r?.points || [];
    if (!pts.length) return { mmsi, hours, points: 0, note: 'No recorded positions for this ship in this period (it may be outside the collector area or not heard).' };
    let km = 0, maxSog = 0;
    for (let i = 1; i < pts.length; i++) km += kmBetween(pts[i - 1][1], pts[i - 1][2], pts[i][1], pts[i][2]);
    for (const p of pts) if (p[3] != null && p[3] < 102) maxSog = Math.max(maxSog, p[3]);
    const step = Math.max(1, Math.ceil(pts.length / maxPts));
    const sample = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => ({
      ...fmtTime(new Date(p[0]), a.timezone), latitude: r3(p[1]), longitude: r3(p[2]), speed_knots: p[3], course_deg: p[4] }));
    const spanH = (pts[pts.length - 1][0] - pts[0][0]) / 36e5;
    return { mmsi, hours, recorded_points: pts.length, returned_points: sample.length,
      first: fmtTime(new Date(pts[0][0]), a.timezone), last: fmtTime(new Date(pts[pts.length - 1][0]), a.timezone),
      distance_km: r1(km), average_speed_knots: spanH > 0 ? r1(km / spanH / 1.852) : null, max_speed_knots: r1(maxSog),
      track: sample, source: 'AIS collector database' };
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
