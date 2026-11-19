// เรียก API ของตัวเก็บข้อมูลเรือ (collector) จากฝั่ง Vercel
// ตั้งค่าด้วย Environment Variables: COLLECTOR_URL (เช่น https://ais.example.com) และ COLLECTOR_TOKEN
const base = () => String(process.env.COLLECTOR_URL || '').trim().replace(/\/+$/, '');
const token = () => String(process.env.COLLECTOR_TOKEN || '').trim();
export const hasCollector = () => !!base() && !!token();

export async function collectorGet(path, params = {}, timeoutMs = 15000) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base()}${path}${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`collector HTTP ${res.status}: ${body.error || ''}`);
  return body;
}
