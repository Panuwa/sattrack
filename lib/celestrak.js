// ดึงข้อมูลวงโคจร (OMM/JSON) จาก CelesTrak พร้อมแคช
// CelesTrak อัปเดตข้อมูลประมาณทุก 2 ชั่วโมง และขอให้ไม่ดึงข้อมูลชุดเดิมถี่กว่านั้น
import * as satellite from 'satellite.js';
import { GROUPS, GROUP_IDS, makeRecord } from '../public/orbit-core.js';

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const TTL_MS = 2 * 60 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

export { GROUPS, GROUP_IDS, satellite };

async function fetchOMM(query) {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const get = () => fetch(`${BASE}?${query}&FORMAT=json`, {
      headers: { 'User-Agent': 'sattrack-mcp/1.0 (personal satellite tracker)' },
      signal: AbortSignal.timeout(20000),
    });
    // ลองใหม่อีกครั้งถ้าครั้งแรกล้มเหลว (CelesTrak บางครั้งตอบผิดพลาดชั่วคราว)
    let res = await get().catch(() => null);
    if (!res || res.status >= 500) { await new Promise(r => setTimeout(r, 1500)); res = await get(); }
    const text = await res.text();
    if (!res.ok && res.status !== 404) throw new Error(`CelesTrak HTTP ${res.status}`);
    // ถ้าไม่พบข้อมูล CelesTrak จะตอบเป็นข้อความธรรมดา ไม่ใช่ JSON
    const data = text.trim().startsWith('[') ? JSON.parse(text) : [];
    cache.set(query, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit) return hit.data; // ใช้ข้อมูลเก่าไปก่อนถ้า CelesTrak ล่ม
    throw err;
  }
}

export function getGroupOMM(groupId) {
  if (!GROUP_IDS.includes(groupId)) throw new Error(`Unknown group "${groupId}". Use one of: ${GROUP_IDS.join(', ')}`);
  return fetchOMM(`GROUP=${encodeURIComponent(groupId)}`);
}

export async function getGroupRecords(groupId) {
  return (await getGroupOMM(groupId)).map(o => makeRecord(satellite, o)).filter(Boolean);
}

export async function getByNorad(norad) {
  const id = parseInt(norad, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('norad_id must be a positive integer');
  const list = await fetchOMM(`CATNR=${id}`);
  return list.length ? makeRecord(satellite, list[0]) : null;
}

export async function searchByName(name) {
  const q = String(name || '').trim();
  if (q.length < 2) throw new Error('query must be at least 2 characters');
  return (await fetchOMM(`NAME=${encodeURIComponent(q)}`)).map(o => makeRecord(satellite, o)).filter(Boolean);
}
