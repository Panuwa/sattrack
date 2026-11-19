// ทดสอบว่า AISStream API key ใช้ได้หรือไม่ (รันบนเครื่องตัวเอง)
//   macOS/Linux:  AISSTREAM_API_KEY='ใส่key' node scripts/test-aisstream.mjs
//   หรือใส่ key ในไฟล์ .env แล้ว:  node --env-file=.env scripts/test-aisstream.mjs
import WebSocket from 'ws';
const key = String(process.env.AISSTREAM_API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
if (!key) { console.log('❌ ไม่พบ AISSTREAM_API_KEY'); process.exit(1); }
console.log(`key ยาว ${key.length} ตัวอักษร (ขึ้นต้น ${key.slice(0, 4)}…) กำลังเชื่อมต่อ…`);
const ws = new WebSocket('wss://stream.aisstream.io/v0/stream', { perMessageDeflate: true, handshakeTimeout: 20000 });
let n = 0, ok = false;
ws.on('open', () => ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[0.5, 103], [2, 105]]], FilterMessageTypes: ['PositionReport'] })));
ws.on('message', d => {
  const m = JSON.parse(d.toString());
  if (m.MessageType === 'SubscriptionConfirmation') { ok = true; console.log('✅ AISStream ยืนยันแล้ว key ใช้ได้ กำลังรอข้อมูลเรือ…'); return; }
  ok = true; n++;
  if (n <= 3) console.log(`🚢 ${m.MetaData?.ShipName?.trim()} MMSI ${m.MetaData?.MMSI}`);
  if (n === 3) { console.log('✅ ได้รับข้อมูลเรือแล้ว ทุกอย่างปกติ'); process.exit(0); }
});
ws.on('close', (c, r) => { console.log(ok ? `ปิดการเชื่อมต่อ (ได้ข้อความ ${n})` : `❌ AISStream ปิดการเชื่อมต่อ code ${c} ${r} → key ไม่ถูกต้อง หรือมีการเชื่อมต่อค้างอยู่เกิน 3 ช่องทาง`); process.exit(ok ? 0 : 1); });
ws.on('error', e => console.log('❌ error:', e.message));
setTimeout(() => { console.log(ok ? `หมดเวลา ได้ข้อความ ${n}` : '❌ ไม่ได้รับการยืนยันภายใน 30 วินาที'); process.exit(ok ? 0 : 1); }, 30000);
