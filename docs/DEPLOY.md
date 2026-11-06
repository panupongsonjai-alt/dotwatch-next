# ขึ้นระบบจริง (Render + Tiger Cloud + Firebase)

ทำครั้งเดียว ใช้เวลาประมาณ 30–45 นาที หลังจากนี้ทุกครั้งที่ `git push` ขึ้น `main` Render จะ build และ deploy ให้เอง

## 1. ฐานข้อมูล production (Tiger Cloud)

1. ที่ Tiger Cloud สร้าง service ใหม่ชื่อ `dotwatch-prod` (TimescaleDB, region Singapore) แยกจาก `dotwatch-dev`
2. copy connection string แล้วเปลี่ยนท้ายเป็น `?uselibpqcompat=true&sslmode=require` เหมือนตอนตั้งเครื่อง dev

Free plan ใช้ทดลองได้ แต่ก่อน cutover ควรเปลี่ยนเป็นแพ็กเกจเสียเงิน เพื่อให้มี backup และ certificate ที่ตรวจได้

## 2. Firebase (project เดิมของระบบเก่า)

ใช้ project เดิม เพื่อให้ผู้ใช้เดิมเข้าด้วยรหัสผ่านเดิมได้ (ADR ข้อ 6)

1. Firebase console → Project settings → General → Your apps → เว็บแอป → copy `apiKey`, `authDomain`, `projectId`
2. Authentication → Sign-in method → เปิด **Email/Password**
3. Authentication → Settings → **Authorized domains** → เพิ่มโดเมนของเว็บบน Render (ได้หลังขั้น 3 เช่น `dotwatch-web.onrender.com`)

## 3. Render

1. สมัคร/เข้า https://dashboard.render.com แล้วเชื่อม GitHub
2. **New → Blueprint** → เลือก repo `dotwatch-next` → Render อ่าน `render.yaml` และสร้าง 2 service
3. ใส่ค่าที่ Render ถาม:

| Service | ตัวแปร | ค่า |
|---|---|---|
| dotwatch-api | `DATABASE_URL` | connection string จากขั้น 1 |
| | `FIREBASE_PROJECT_ID` | `projectId` จากขั้น 2 |
| | `CORS_ORIGIN` | `https://dotwatch-web.onrender.com` (ชื่อจริงดูได้หลังสร้าง) |
| | `APP_URL` | ค่าเดียวกับ `CORS_ORIGIN` |
| | `LINE_*`, `RESEND_API_KEY`, `EMAIL_FROM` | เว้นว่างได้ (ส่งลง log แทน) |
| dotwatch-web | `VITE_API_URL` | `https://dotwatch-api.onrender.com` (ชื่อจริงดูได้หลังสร้าง) |
| | `VITE_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` | จากขั้น 2 |

4. ถ้าชื่อโดเมนจริงต่างจากที่ใส่ไว้ ให้แก้ใน Environment ของแต่ละ service แล้วกด **Manual Deploy**
   ค่า `VITE_*` ฝังตอน build จึงต้อง deploy เว็บใหม่ทุกครั้งที่แก้

`DEVICE_SECRET_PEPPER` Render สร้างให้เอง **ห้ามเปลี่ยน** เพราะรหัสลับของทุกบอร์ดผูกกับค่านี้

## 4. ตรวจ

1. เปิด `https://dotwatch-api.onrender.com/health` → ต้องได้ `{"ok":true}`
2. เปิดเว็บ → สร้างบัญชีด้วยอีเมลจริง → กดลิงก์ยืนยันในอีเมล
3. เพิ่มอุปกรณ์ → รัน simulator จากเครื่องให้ส่งเข้า production:
   ```powershell
   cd services\api
   npx tsx src/scripts/simulate.ts --api https://dotwatch-api.onrender.com --code <รหัส> --secret <รหัสลับ>
   ```

## 5. LINE webhook (เชื่อม LINE ด้วยรหัส)

LINE Developers → channel → Messaging API → **Webhook URL** = `https://dotwatch-api.onrender.com/v1/line/webhook`
→ กด Verify → เปิด **Use webhook** และปิด **Auto-reply messages** ใน LINE Official Account Manager

## หลังจากนี้

- `git push` ขึ้น `main` = deploy อัตโนมัติ ส่วน API จะ migrate ก่อนรับ traffic และถ้า migrate ไม่ผ่าน ระบบเดิมทำงานต่อ
- ดู log ที่ Render → dotwatch-api → Logs
