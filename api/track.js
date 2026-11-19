// GET /api/track?mmsi=123456789&hours=24  → เส้นทางย้อนหลังของเรือ (ต้องมี collector)
import { hasCollector, collectorGet } from '../lib/collector.js';

export default async function handler(req, res) {
  const q = new URL(req.url, 'http://local').searchParams;
  res.setHeader('Content-Type', 'application/json');
  if (!hasCollector()) { res.statusCode = 501; return res.end(JSON.stringify({ error: 'History needs the AIS collector (COLLECTOR_URL + COLLECTOR_TOKEN).', code: 'NO_COLLECTOR' })); }
  const mmsi = Number(q.get('mmsi')), hours = Math.min(24 * 90, Math.max(0.1, Number(q.get('hours')) || 24));
  if (!Number.isInteger(mmsi) || mmsi <= 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'mmsi is required' })); }
  try {
    const r = await collectorGet('/track', { mmsi, hours });
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.end(JSON.stringify({ source: 'collector', mmsi, hours, count: r?.count || 0, points: r?.points || [] }));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: e.message, code: 'COLLECTOR_DOWN' }));
  }
}
