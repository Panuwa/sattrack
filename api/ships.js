// GET /api/ships?bbox=south,west,north,east[&seconds=8]  → เรือในพื้นที่ (จาก AISStream)
// GET /api/ships?mmsi=123456789                          → หาเรือลำเดียวจาก MMSI ทั่วโลก (รอสูงสุด ~25 วินาที)
import { hasKey, normBox, shipsInBoxes, findShip, publicVessel } from '../lib/aisstream.js';

const send = (res, status, body, cache) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (cache) res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
};

export default async function handler(req, res) {
  if (!hasKey()) return send(res, 503, { error: 'Ship tracking is not set up: add AISSTREAM_API_KEY in the server environment variables.', code: 'NO_KEY' });
  const q = new URL(req.url, 'http://local').searchParams;
  try {
    if (q.get('mmsi')) {
      const v = await findShip(q.get('mmsi'), 25);
      if (!v) return send(res, 404, { error: 'No position received for this MMSI in 25 seconds. The ship may be out of AIS coverage, or transmits rarely (e.g. at anchor every 3 minutes). Try again.', code: 'NOT_FOUND' }, 'no-store');
      return send(res, 200, { source: 'aisstream.io', vessel: publicVessel(v) }, 'public, s-maxage=20, stale-while-revalidate=40');
    }
    const parts = (q.get('bbox') || '').split(',').map(Number);
    if (parts.length !== 4 || parts.some(x => !Number.isFinite(x))) return send(res, 400, { error: 'bbox=south,west,north,east is required' });
    const [s, w, n, e] = parts;
    if (Math.abs(n - s) > 60 || ((e - w + 360) % 360 || 360) > 90) return send(res, 400, { error: 'Area too large: max 60° latitude × 90° longitude. Zoom in.', code: 'TOO_LARGE' });
    const seconds = Math.min(20, Math.max(3, Number(q.get('seconds')) || 8));
    const boxes = normBox(s, w, n, e);
    const out = await shipsInBoxes(boxes, seconds);
    send(res, 200, { source: 'aisstream.io', fetchedAt: new Date().toISOString(), boxes, listenedSeconds: seconds,
      messages: out.messages, count: out.vessels.length, vessels: out.vessels.map(publicVessel) },
      'public, s-maxage=30, stale-while-revalidate=60');
  } catch (err) {
    send(res, err.code === 'REJECTED' ? 502 : 502, { error: err.message, code: err.code || 'UPSTREAM' }, 'no-store');
  }
}
