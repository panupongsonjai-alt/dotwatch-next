# ADR 0001 — เขียน dotWatch ใหม่ทั้งระบบ

สถานะ: ตกลงแล้ว (2026-11-01)

| # | เรื่อง | ตัดสินใจ | เหตุผลหลัก |
|---|---|---|---|
| 1 | ขอบเขต | เขียนใหม่ทั้งระบบ | — |
| 2 | สัญญาอุปกรณ์ | เปลี่ยนได้ | อุปกรณ์หน้างานไม่เกิน 10 ตัว |
| 3 | การย้ายอุปกรณ์ | แฟลช USB ในวัน cutover | OTA เดิมยังไม่เคยใช้จริง จึงไม่พึ่ง OTA และไม่ต้องมีชั้น compatibility |
| 3b | OTA ใหม่ | มี rollback partition และ health check หลังบูต | ต้องทดสอบบนบอร์ดจริงก่อนจึงจะนับว่าใช้ได้ |
| 4 | ข้อมูลเดิม | ย้ายทั้งหมด รวม telemetry | ข้อมูลหลักล้านแถว สคริปต์ต้องรันซ้ำได้และเทียบยอดแถวได้ |
| 5 | Stack | Node + TypeScript, React + Vite, Expo, Python (Pi), ESP | เปลี่ยนสถาปัตยกรรม ไม่เปลี่ยนภาษา |
| 6 | Login | Firebase Auth ผูกกับ user ด้วย UID | ผู้ใช้ไม่ต้องรีเซ็ตรหัสผ่าน |
| 7 | สิทธิ์ | องค์กรเป็นเจ้าของทุกอย่าง บทบาท owner/admin/member/viewer เช็คผ่าน `can()` จุดเดียว | แก้ข้อ 6.3 |
| 8 | Alarm | ช่วงปกติ + delay + hysteresis + offline alarm แยกชนิด | กฎเดิม `>8` แปลงเป็น max=8, delay=0 พฤติกรรมเหมือนเดิม |
| 9 | แจ้งเตือน | LINE OA (Messaging API) + Expo push + email แจ้งซ้ำจนรับทราบ (มีเพดาน) | escalation ทำในเฟสหลัง |
| 10 | โปรโตคอล | HTTPS keep-alive + batch + คำสั่งแนบใน response | service เดียว และ debug ด้วย curl ได้ ย้ายไป MQTT เมื่ออุปกรณ์มีหลักร้อยตัว |
| 11 | Telemetry | ตาราง `readings` แบบแคบ + `latest` + continuous aggregate และรับ backfill 7 วัน | แก้ข้อ 6.4, 6.5, 6.10 |
| 12 | DB | Tiger Cloud region เดียวกับ backend บน Render | Render Postgres ไม่มีฟีเจอร์ Timescale Community |
| 13 | Realtime | WebSocket เส้นเดียวต่อ client กรองด้วย `can()` backend instance เดียว | การกระจายข้อมูลแยกเป็น interface `Broadcaster` |
| 14 | Repo | npm workspaces รวม Admin เข้า web และมี `packages/shared` | React/Vite ชุดเดียว |
| 15 | ลำดับงาน | slice → alarm → history → ซ้อมย้ายข้อมูล → ส่วนที่เหลือ → cutover | ดูเกณฑ์ด้านล่าง |

## เกณฑ์ก่อน cutover

- ซ้อมย้ายข้อมูลผ่าน 2 รอบติดต่อกัน (ยอดแถวตรงกัน 100%)
- บอร์ดทดสอบรันต่อเนื่อง 7 วันโดยไม่หลุด
- alarm ยิงจริงครบทุกช่องทาง
- ผู้ใช้ทดสอบ login แล้วเห็นข้อมูลเดิมครบ
- เก็บระบบเก่าแบบอ่านอย่างเดียว 30 วันไว้เผื่อ rollback
