// รันทดสอบบนเครื่องตัวเอง: npm run dev แล้วเปิด http://localhost:3000
// (บน Vercel ไม่ใช้ไฟล์นี้ Vercel จะจัดการ public/ และ api/ ให้เอง)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import tle from './api/tle.js';
import mcp from './api/mcp.js';
import ships from './api/ships.js';
import track from './api/track.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/api/tle') return tle(req, res);
  if (path === '/api/ships') return ships(req, res);
  if (path === '/api/track') return track(req, res);
  if (path === '/mcp' || path === '/api/mcp') return mcp(req, res);
  const file = normalize(join('public', path === '/' ? 'index.html' : path));
  if (!file.startsWith('public')) { res.statusCode = 403; return res.end(); }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen(PORT, () => console.log(`Website: http://localhost:${PORT}\nMCP:     http://localhost:${PORT}/mcp`));
