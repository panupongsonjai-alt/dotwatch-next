# dotWatch (เขียนใหม่)

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

## สถานะ

| ชุด | เนื้อหา | สถานะ |
|---|---|---|
| Slice 1 | ingest → `readings`/`latest` → WebSocket → การ์ดบนเว็บ | เสร็จ |
| Alarm | กฎช่วงปกติ + delay + hysteresis, รับทราบ, หน้าแจ้งเตือนบนเว็บ | เสร็จ |
| ชุดที่ 1 | หน้าอุปกรณ์ + กราฟย้อนหลัง, จัดการอุปกรณ์, แจ้งเตือนขาดการติดต่อ | เสร็จ |
| ชุดที่ 2 | ส่งแจ้งเตือน LINE OA / email, แจ้งซ้ำจนรับทราบ | เสร็จ |
| ชุดที่ 3 | จัดการองค์กรและสมาชิก, Firebase login จริง, deploy (Render + Tiger Cloud) | เสร็จ ([วิธีขึ้นระบบ](docs/DEPLOY.md)) |
| ชุดที่ 4 | สคริปต์ย้ายข้อมูลจากระบบเก่า (ซ้อม 2 รอบ), continuous aggregate + compression/retention | ถัดไป |
| ชุดที่ 5 | Mobile, Pi agent, OTA, firmware บนบอร์ดจริง แล้ว cutover | |

ช่องทางส่งคำสั่งกลับไปที่อุปกรณ์ (`commands` ใน response ของ ingest) มีอยู่ในสัญญาแล้ว แต่ตอนนี้ยังส่งกลับเป็นรายการว่าง

## Alarms

Rules are per device + metric + severity (`warning` / `critical`): a normal range (`min`, `max` or both),
`delaySec` before an alarm opens and `hysteresis` before it closes. They are evaluated on every reading that
advances `latest`; older queued readings are stored but never re-open or close alarms.

| Method | Path | Who |
|---|---|---|
| GET | `/v1/devices/:id/alarm-rules` | anyone who can see the device |
| PUT | `/v1/devices/:id/alarm-rules` `{ rules: [...] }` | member and above (replaces the whole set) |
| GET | `/v1/alarms?state=open\|all&orgId=&deviceId=&limit=&before=` | members of the organization |
| POST | `/v1/alarms/:id/ack` | member and above |

Opened, closed and acknowledged events are pushed over WebSocket as `{ type: "alarm", orgId, event }`.
Changing or removing a rule closes its open event (no end value), because it was judged against old limits.

### Offline alarms

Each device has `offlineAfterSec` (default 900, `null` = off). A check every 30 s opens one `critical` event
with `kind: "offline"` (no value; `startedAt` = last contact) for live devices silent longer than that, and
closes it when the device reports again (immediately, from ingest), the setting is turned off, or the device
is deleted. A partial unique index keeps it to one open offline event per device.

## Devices and history

| Method | Path | Who |
|---|---|---|
| GET | `/v1/devices?orgId=` | members |
| POST | `/v1/devices` `{ orgId, name, code? }` → `{ device, secret }` | admin and above |
| GET | `/v1/devices/:id` | anyone who can see the device |
| PATCH | `/v1/devices/:id` `{ name?, offlineAfterSec? }` | name: admin+, offline setting: member+ |
| DELETE | `/v1/devices/:id` | admin and above (soft delete; open alarms close) |
| POST | `/v1/devices/:id/reset-secret` → `{ secret }` | admin and above |
| GET | `/v1/devices/:id/history?metrics=a,b&from=&to=` | anyone who can see the device |

History returns every requested metric in one response, bucketed with `date_bin` so a chart gets at most
about 360 points (1 min buckets for 6 h up to 6 h buckets). Each point has `avg`, `min`, `max`, `n` and
`backfilled`. It reads `readings` directly through its primary key; continuous aggregates come with batch 4.

The web app has two screens addressed by the URL hash: `#/` (all devices) and `#/devices/<id>`.

## Organizations and members

| Method | Path | Who |
|---|---|---|
| POST | `/v1/orgs` `{ name }` | anyone (becomes owner) |
| PATCH / DELETE | `/v1/orgs/:orgId` | rename: admin+, delete: owner (not personal, no live devices) |
| GET | `/v1/orgs/:orgId/members` | members (invitations only for admin+) |
| POST | `/v1/orgs/:orgId/invitations` `{ email, role }` | admin+ (owner role: owners only) |
| POST | `/v1/invitations/:id/accept` | the invited email, verified |
| DELETE | `/v1/invitations/:id` | admin+ (revoke) or the invitee (decline) |
| PATCH / DELETE | `/v1/orgs/:orgId/members/:userId` | admin+; owners only for owners; anyone can leave; the last owner stays |
| POST | `/v1/devices/:id/move` `{ orgId }` | admin+ in both organizations |

`/v1/me` also returns `emailVerified` and pending `invitations`. When someone's role changes or they are removed,
their open sockets get `{ type: "membership", orgId }` and lose the subscription at once.
In dev mode, sign in as `name:email` to get a token with a verified email.

Deploy: [`render.yaml`](render.yaml) and [`docs/DEPLOY.md`](docs/DEPLOY.md).
