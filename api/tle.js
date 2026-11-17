// GET /api/tle?group=starlink → ข้อมูลวงโคจรของทั้งกลุ่ม (แบบย่อ) ให้หน้าเว็บคำนวณตำแหน่งเอง
// CDN ของ Vercel แคชไว้ 2 ชั่วโมง ทำให้ผู้ชมทุกคนใช้ข้อมูลชุดเดียวกันโดยไม่ต้องดึงจาก CelesTrak ซ้ำ
// (ถ้า endpoint นี้ใช้ไม่ได้ หน้าเว็บจะดึงจาก CelesTrak โดยตรงแทน)
import { getGroupOMM, GROUP_IDS } from '../lib/celestrak.js';
import { FIELDS, packOMM } from '../public/orbit-core.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const group = url.searchParams.get('group');
  if (!GROUP_IDS.includes(group)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: `group must be one of: ${GROUP_IDS.join(', ')}` }));
  }
  try {
    const list = await getGroupOMM(group);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=7200, stale-while-revalidate=86400');
    res.end(JSON.stringify({ group, fetchedAt: new Date().toISOString(), fields: FIELDS, rows: packOMM(list) }));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Could not reach CelesTrak: ${err.message}` }));
  }
}
