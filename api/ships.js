// GET /api/ships?bbox=south,west,north,east[&seconds=8]  → เรือในพื้นที่
// GET /api/ships?mmsi=123456789                          → หาเรือลำเดียวจาก MMSI
// ถ้าตั้ง collector ไว้ จะอ่านจากฐานข้อมูลของ collector (เร็วและครบกว่า) ไม่ต้องเปิดการเชื่อมต่อ AISStream ใหม่
import { hasKey, normBox, shipsInBoxes, findShip, publicVessel } from '../lib/aisstream.js';
import { hasCollector, collectorGet } from '../lib/collector.js';

const send = (res, status, body, cache) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (cache) res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
};

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://local').searchParams;
  const collector = hasCollector();
  if (!collector && !hasKey()) return send(res, 503, { error: 'Ship tracking is not set up: add AISSTREAM_API_KEY (or COLLECTOR_URL + COLLECTOR_TOKEN) in the server environment variables.', code: 'NO_KEY' });
  let collectorError = null;
  try {
    if (q.get('mmsi')) {
      if (collector) {
        try {
          const r = await collectorGet('/ship', { mmsi: q.get('mmsi') });
          if (r?.vessel) return send(res, 200, { source: 'collector', vessel: r.vessel }, 'public, s-maxage=15, stale-while-revalidate=30');
        } catch (e) { collectorError = e.message; }
        if (!hasKey()) return send(res, 404, { error: 'This MMSI is not in the collector database yet.', code: 'NOT_FOUND', collectorError }, 'no-store');
      }
      const v = await findShip(q.get('mmsi'), 25);
      if (!v) return send(res, 404, { error: 'No position received for this MMSI in 25 seconds. The ship may be out of AIS coverage, or transmits rarely (e.g. at anchor every 3 minutes). Try again.', code: 'NOT_FOUND' }, 'no-store');
      return send(res, 200, { source: 'aisstream.io', vessel: publicVessel(v) }, 'public, s-maxage=20, stale-while-revalidate=40');
    }
    const parts = (q.get('bbox') || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(x => !Number.isFinite(x))) return send(res, 400, { error: 'bbox=south,west,north,east is required' });
    const [s, w, n, e] = parts;
    if (Math.abs(n - s) > 60 || ((e - w + 360) % 360 || 360) > 90) return send(res, 400, { error: 'Area too large: max 60° latitude × 90° longitude. Zoom in.', code: 'TOO_LARGE' });
    if (collector) {
      try {
        const r = await collectorGet('/ships', { bbox: parts.join(','), maxAgeMin: 60 });
        if (r) return send(res, 200, { source: 'collector', fetchedAt: new Date().toISOString(), count: r.count, vessels: r.vessels, collector: r.stats },
          'public, s-maxage=15, stale-while-revalidate=30');
      } catch (e2) { collectorError = e2.message; }
      if (!hasKey()) return send(res, 502, { error: `Collector unreachable: ${collectorError}`, code: 'COLLECTOR_DOWN' }, 'no-store');
    }
    const seconds = Math.min(20, Math.max(3, Number(q.get('seconds')) || 8));
    const boxes = normBox(s, w, n, e);
    const out = await shipsInBoxes(boxes, seconds);
    send(res, 200, { source: 'aisstream.io', fetchedAt: new Date().toISOString(), boxes, listenedSeconds: seconds,
      messages: out.messages, count: out.vessels.length, vessels: out.vessels.map(publicVessel), collectorError },
      'public, s-maxage=30, stale-while-revalidate=60');
  } catch (err) {
    send(res, 502, { error: err.message, code: err.code || 'UPSTREAM' }, 'no-store');
  }
}
