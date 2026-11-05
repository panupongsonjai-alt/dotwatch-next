# dotWatch (เขียนใหม่) — Slice 1

Slice 1 พิสูจน์สถาปัตยกรรมใหม่ครบทั้งเส้นทาง:
**บอร์ด → `POST /v1/ingest` → `readings` / `latest` → WebSocket → การ์ดบนเว็บอัปเดตเอง**

การตัดสินใจทั้งหมดอยู่ใน [`docs/adr/0001-rewrite-decisions.md`](docs/adr/0001-rewrite-decisions.md)

## โครงสร้าง

```
packages/shared   สัญญาอุปกรณ์ (zod), can(), โปรโตคอล realtime — ใช้ร่วมกันทั้ง API และเว็บ
services/api      Node + TypeScript (Express, pg, ws)
apps/web          React 18 + Vite 5
firmware/esp32    เฟิร์มแวร์ slice 1 (HTTPS keep-alive + batch + คิว)
```

## รันในเครื่อง (Windows, PowerShell)

ต้องมี Node 20 ขึ้นไป และ Docker Desktop

```powershell
npm install
docker compose up -d db
copy services\api\.env.example services\api\.env
copy apps\web\.env.example apps\web\.env.local
npm run db:migrate
npm run db:seed
```

แล้วเปิด 3 หน้าต่าง terminal:

```powershell
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:5173  (เข้าด้วยชื่อ dev-user)
npm run simulate     # บอร์ดจำลอง ส่งค่าทุก 15 วินาที
```

ค่าบนการ์ดจะขยับเองโดยไม่ต้องรีเฟรช แถบใต้การ์ดจะค่อย ๆ หดลงตามอายุของค่าล่าสุด
ถ้าเกิน 5 นาทีโดยไม่มีค่าใหม่ การ์ดจะเปลี่ยนเป็นสีเทาและขึ้นว่าออฟไลน์

ลองกรณีเน็ตหลุด: `npm run simulate -- --outage 60` บอร์ดจำลองจะเก็บค่าไว้ 60 วินาทีแล้วค่อยส่ง
ค่าย้อนหลังจะถูกบันทึกเป็น `backfilled = true` และค่าบนการ์ดไม่ถอยหลัง

## ตรวจทุกอย่าง

```powershell
npm run check       # typecheck + test + build ทุก workspace
```

test ของ API ใช้ PostgreSQL จริง ในฐานข้อมูล `dotwatch_test` (สร้างให้เองอัตโนมัติ)
ถ้าชื่อฐานข้อมูลไม่มีคำว่า `test` สคริปต์จะไม่ยอมรัน

| ชุด test | ครอบคลุม |
|---|---|
| shared (10) | `can()`, สัญญา ingest, การจัดเวลา reading, backoff ของ realtime |
| api (21) | ingest, การส่งซ้ำไม่ซ้ำข้อมูล, reading เก่าถูกตัดทีละตัว (คิวไม่ค้าง), `latest` ไม่ถอยหลัง, 401/400/409, deadlock regression (40 request กับ pool ขนาด 2), สิทธิ์องค์กร, realtime ถึงสมาชิกองค์กร, ปฏิเสธ subscribe องค์กรอื่น |
| web (5) | reducer ของค่าสด, ความสดของข้อมูล, ลำดับ metric |

## บอร์ดจริง (ESP32)

1. คัดลอก `firmware/esp32/dotwatch_slice1/config.example.h` เป็น `config.h`
2. ใส่ WiFi, `API_BASE_URL` (IP ของเครื่องที่รัน API ในวง LAN), `DEVICE_CODE` และ `DEVICE_SECRET` จาก `services/api/.demo-device.json`
3. ติดตั้งไลบรารี ArduinoJson 7.x (และ DHT sensor library ถ้าต่อ DHT22) แล้วแฟลช
4. เปิด Serial Monitor ที่ 115200 จะเห็น `sent N, queue M`

> เฟิร์มแวร์นี้ยัง**ไม่ได้คอมไพล์หรือทดสอบบนบอร์ดจริง** ส่วน API และเว็บทดสอบแล้ว
> ถ้ารันจากเครื่อง Windows อาจต้องเปิด firewall ที่ port 4000 ให้บอร์ดในวง LAN เข้าถึงได้

## Firebase (production)

- API: `AUTH_MODE=firebase` และ `FIREBASE_PROJECT_ID=<project เดิม>`
- เว็บ: `VITE_AUTH_MODE=firebase` และค่า `VITE_FIREBASE_*` ของ project เดิม

ถ้า `NODE_ENV=production` แต่ตั้ง `AUTH_MODE=dev` ไว้ API จะไม่ยอม start
ส่วน login ผ่าน Firebase บนเว็บเขียนไว้แล้ว แต่ยังไม่ได้ทดสอบกับ project จริง

## สิ่งที่ slice 1 ยังไม่มี (ลำดับถัดไป)

1. **Alarm + แจ้งเตือน:** ช่วงปกติ, delay, hysteresis, LINE OA, push, email และการรับทราบ
2. **History:** continuous aggregate 5 นาที/ชั่วโมง/วัน, หน้ากราฟ, แรเงาช่วง backfill และ compression/retention policy
3. **สคริปต์ย้ายข้อมูลจากระบบเก่า**
4. หน้าจัดการองค์กรและสมาชิก, Admin, แพ็กเกจ, Mobile, Pi agent และ OTA ใหม่

ช่องทางส่งคำสั่งกลับไปที่อุปกรณ์ (`commands` ใน response ของ ingest) มีอยู่ในสัญญาแล้ว แต่ตอนนี้ยังส่งกลับเป็นรายการว่าง
