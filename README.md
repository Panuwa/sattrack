# sattrack — เว็บติดตามดาวเทียม + Connector สำหรับ Claude

โปรเจกต์เดียวได้สองอย่าง:

1. **หน้าเว็บ** แผนที่โลกแสดงตำแหน่งดาวเทียมแบบเรียลไทม์ แยกตามระบบ (Starlink, GPS, OneWeb, BeiDou ฯลฯ) เลื่อนเวลาไปข้างหน้า/ย้อนหลังได้ 12 ชม. คลิกดาวเทียมเพื่อดูทิศที่กำลังเคลื่อนที่ ความสูง ความเร็ว เส้นทางวงโคจร และเวลาที่จะผ่านเหนือตำแหน่งของคุณ
2. **MCP server** ที่ `/mcp` ให้ Claude เชื่อมต่อเป็น custom connector แล้วถามเป็นภาษาธรรมดาได้ เช่น “ตอนนี้ Starlink ดวงไหนอยู่เหนือกรุงเทพฯ และกำลังไปทางไหน”

ข้อมูลวงโคจรมาจาก [CelesTrak](https://celestrak.org) (ฟรี ไม่ต้องสมัคร) และคำนวณตำแหน่งด้วย SGP4 ผ่านไลบรารี [satellite.js](https://github.com/shashwatak/satellite-js)

## โครงสร้างไฟล์

```
public/index.html      หน้าเว็บ
public/orbit-core.js   สูตรคำนวณวงโคจร ใช้ร่วมกันทั้งหน้าเว็บและ MCP server
api/tle.js             GET /api/tle?group=…  ดึงข้อมูลจาก CelesTrak ให้หน้าเว็บ (CelesTrak ไม่เปิด CORS)
api/mcp.js             POST /mcp  MCP server (Streamable HTTP, stateless)
lib/celestrak.js       ดึงข้อมูลจาก CelesTrak พร้อมแคช 2 ชั่วโมง
dev-server.js          เซิร์ฟเวอร์สำหรับทดสอบบนเครื่องตัวเอง
vercel.json            ตั้งค่า Vercel (ให้ /mcp ชี้ไปที่ api/mcp.js)
```

## ทดสอบบนเครื่องตัวเอง

ต้องมี Node.js 20 ขึ้นไป

```bash
npm install
npm run dev
```

เปิด http://localhost:3000 ดูหน้าเว็บ และทดสอบ MCP ได้ด้วย:

```bash
curl -s localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_satellite","arguments":{"norad_id":25544,"timezone":"Asia/Bangkok"}}}'
```

## นำขึ้นออนไลน์ผ่าน GitHub + Vercel (ฟรี)

ทำไมไม่ใช้ GitHub Pages: GitHub Pages รันได้แค่ไฟล์ static แต่ MCP server ต้องมีโค้ดฝั่งเซิร์ฟเวอร์ จึงใช้ Vercel ซึ่งดึงโค้ดจาก GitHub ไป deploy ให้อัตโนมัติทุกครั้งที่ push

1. สร้าง repository ใหม่บน GitHub (เช่น `sattrack`) แล้ว push โค้ดขึ้นไป

   ```bash
   git init
   git add .
   git commit -m "first version"
   git branch -M main
   git remote add origin https://github.com/<ชื่อผู้ใช้>/sattrack.git
   git push -u origin main
   ```

2. ไปที่ https://vercel.com → Sign up ด้วยบัญชี GitHub → **Add New… → Project** → เลือก repo `sattrack` → กด **Deploy** (ไม่ต้องตั้งค่าอะไรเพิ่ม)
3. รอประมาณ 1 นาที จะได้ URL เช่น `https://sattrack-xxxx.vercel.app`
   - หน้าเว็บ: `https://sattrack-xxxx.vercel.app`
   - MCP: `https://sattrack-xxxx.vercel.app/mcp`

หลังจากนี้ทุกครั้งที่ `git push` Vercel จะ deploy เวอร์ชันใหม่ให้เอง

> แพ็กเกจ Hobby ของ Vercel ฟรีสำหรับการใช้งานส่วนตัว/ไม่ใช่เชิงพาณิชย์ ถ้าจะใช้เชิงพาณิชย์ให้ดูเงื่อนไขของ Vercel

## เชื่อมต่อกับ Claude

1. ใน Claude ไปที่ **Settings → Connectors → Add custom connector**
2. ตั้งชื่อ เช่น `Satellite tracker` และใส่ URL `https://sattrack-xxxx.vercel.app/mcp`
3. กด Add (ไม่ต้องตั้งค่า OAuth เพราะเป็นข้อมูลสาธารณะ)
4. ในหน้าแชต เปิด connector นี้จากเมนูเครื่องมือ แล้วลองถาม เช่น
   - “ตอนนี้มี Starlink กี่ดวงอยู่ในรัศมี 500 กม. จากกรุงเทพฯ แต่ละดวงไปทางไหน”
   - “ISS จะผ่านเหนือเชียงใหม่ตอนไหนบ้างใน 2 วันข้างหน้า เวลาไทย”
   - “ดาวเทียม THEOS-2 อยู่ตรงไหนตอนนี้”
   - “ขอเส้นทางของ ISS ในอีก 90 นาทีข้างหน้า”

ถ้าใช้ Claude แบบ Team/Enterprise อาจต้องให้ผู้ดูแลองค์กรเป็นคนเพิ่ม connector

### เครื่องมือที่ Claude ใช้ได้

| เครื่องมือ | ทำอะไร |
|---|---|
| `list_constellations` | รายชื่อระบบดาวเทียมที่รองรับ |
| `get_positions` | ตำแหน่ง ความสูง ความเร็ว ทิศทางของดาวเทียมทั้งระบบ ณ เวลาใดก็ได้ กรองตามชื่อหรือรัศมีรอบจุดที่กำหนดได้ |
| `get_satellite` | ข้อมูลดาวเทียมดวงเดียว ค้นจากเลข NORAD หรือชื่อ |
| `get_ground_track` | เส้นทางบนพื้นโลกในช่วงเวลาที่กำหนด |
| `predict_passes` | เวลาที่ดาวเทียมจะผ่านเหนือตำแหน่งหนึ่ง พร้อมทิศที่ขึ้นและตก |

## ข้อควรรู้

- **ความแม่นยำ** ตำแหน่งเป็นค่าที่คำนวณจาก TLE/OMM คลาดเคลื่อนประมาณไม่กี่กิโลเมตรถ้าข้อมูลใหม่ (อายุ 1–2 วัน) และคลาดมากขึ้นเมื่อข้อมูลเก่า หรือเมื่อดาวเทียมเพิ่งปรับวงโคจร
- **มารยาทกับ CelesTrak** CelesTrak อัปเดตข้อมูลประมาณทุก 2 ชั่วโมงและขอไม่ให้ดึงชุดเดิมถี่กว่านั้น โค้ดจึงแคชไว้ 2 ชั่วโมงทั้งในเซิร์ฟเวอร์และบน CDN ของ Vercel อย่าลดค่า `TTL_MS` ใน `lib/celestrak.js` ถ้าดึงถี่เกินไป IP อาจถูกบล็อก
- **ความปลอดภัย** endpoint `/mcp` ไม่มีการยืนยันตัวตน ใครรู้ URL ก็ใช้ได้ ซึ่งไม่เป็นปัญหาเพราะเป็นข้อมูลสาธารณะและอ่านอย่างเดียว แต่ถ้าในอนาคตเพิ่มข้อมูลจาก Space-Track.org ต้องระวังเงื่อนไข User Agreement ที่ห้ามเผยแพร่ข้อมูลดิบต่อ และควรเก็บรหัสผ่านไว้ใน Environment Variables ของ Vercel ห้ามใส่ในโค้ดหรือ commit ขึ้น GitHub
- **เพิ่มระบบดาวเทียม** แก้รายการ `GROUPS` ใน `public/orbit-core.js` โดยใช้ชื่อกลุ่มตามที่ CelesTrak รองรับ (ดูได้ที่ https://celestrak.org/NORAD/elements/)

## เครดิต

- ข้อมูลวงโคจร: CelesTrak (Dr. T.S. Kelso)
- คำนวณวงโคจร: satellite.js (MIT)
- แผนที่: Leaflet (BSD-2), Natural Earth ผ่าน world-atlas (public domain)
