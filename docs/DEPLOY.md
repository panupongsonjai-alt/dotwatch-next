# ขึ้นระบบจริง — แบบเรียบง่ายและไม่เสียเงิน

ระบบทั้งหมดอยู่บน **Render service เดียว** ทั้งเว็บ, API และจุดรับข้อมูลอุปกรณ์จึงใช้ที่อยู่เดียวกัน เช่น
`https://dotwatch-api.onrender.com`

| ใช้ทำอะไร | บริการ | ค่าใช้จ่าย |
|---|---|---|
| โค้ด | GitHub | ฟรี |
| เว็บ + API | Render (Free) | ฟรี |
| ฐานข้อมูล | Tiger Cloud (Free) | ฟรี |
| Login | Firebase (Spark, project เดิมของระบบเก่า) | ฟรี |
| กัน API หลับ + แจ้งเมื่อระบบล่ม | UptimeRobot (Free) | ฟรี |

## ตั้งครั้งแรก

1. **Tiger Cloud:** สร้าง service `dotwatch-prod` (TimescaleDB, Free, Singapore) แล้ว copy connection string
2. **Firebase:** Project settings → Your apps → เว็บแอป → copy `apiKey` และ `projectId` จากนั้นที่
   Authentication → Sign-in method ให้เปิด Email/Password
3. **Render:** New → Blueprint → repo `dotwatch-next` แล้วใส่ 3 ค่า: `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`
4. **Firebase:** Authentication → Settings → Authorized domains → เพิ่มโดเมนของ service เช่น `dotwatch-api.onrender.com`
5. **UptimeRobot:** HTTP(s) monitor → `https://<โดเมน>/health` → ทุก 5 นาที

ตรวจ: เปิด `https://<โดเมน>` แล้วต้องเห็นหน้า login แบบอีเมลและรหัสผ่าน

## หลังจากนี้

- `git push` ขึ้น `main` = deploy อัตโนมัติ (migrate ให้เองตอน start)
- แก้ค่าใน Render → Environment → Save แล้วระบบจะ restart เอง ไม่ต้อง build ใหม่
- `DEVICE_SECRET_PEPPER` Render สร้างให้เอง **ห้ามแก้** เพราะรหัสลับของทุกบอร์ดผูกกับค่านี้
- บอร์ดและ Pi ส่งข้อมูลไปที่ `https://<โดเมน>/v1/ingest`

## เพิ่มทีหลังเมื่อพร้อม (ไม่บังคับ)

| อยากได้ | เพิ่มใน Render → Environment |
|---|---|
| ส่งแจ้งเตือนเข้า LINE | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` แล้วตั้ง Webhook URL ใน LINE Developers เป็น `https://<โดเมน>/v1/line/webhook` |
| ส่งอีเมลแจ้งเตือนและคำเชิญ | `RESEND_API_KEY`, `EMAIL_FROM` |
| ไม่ต้องพึ่ง UptimeRobot / มี backup | เปลี่ยน `plan: free` เป็น `starter` ใน `render.yaml` และ Tiger Cloud เป็นแพ็กเกจเสียเงิน |
