import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import type { Pool } from "../db/pool";
import { log } from "../lib/log";

/**
 * LINE webhook: links a recipient when someone sends its link code to the official account,
 * in a 1:1 chat (user id) or in a group/room the account was invited to (group/room id).
 * The body is verified with the channel secret before anything is read (X-Line-Signature).
 */
export function verifyLineSignature(body: Buffer, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(body).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type: string; text?: string };
}

const CODE = /\b([A-HJ-NP-Z2-9]{6})\b/;

export function lineWebhook(deps: { pool: Pool; channelSecret: string; accessToken: string }): Router {
  const router = Router();

  const reply = async (replyToken: string | undefined, text: string) => {
    if (!replyToken || !deps.accessToken) return;
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.accessToken}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => log.warn("line reply failed", { error: (err as Error).message }));
  };

  router.post("/", raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
    if (!deps.channelSecret) return void res.status(503).json({ error: "not_configured", message: "LINE_CHANNEL_SECRET is not set." });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyLineSignature(body, req.header("x-line-signature"), deps.channelSecret)) {
      return void res.status(401).json({ error: "bad_signature", message: "Signature does not match." });
    }
    // Answer LINE at once; linking is a couple of quick statements.
    res.status(200).json({ ok: true });

    let events: LineEvent[] = [];
    try {
      events = (JSON.parse(body.toString("utf8")) as { events?: LineEvent[] }).events ?? [];
    } catch {
      return;
    }
    for (const ev of events) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      const code = CODE.exec((ev.message.text ?? "").toUpperCase())?.[1];
      const to = ev.source?.groupId ?? ev.source?.roomId ?? ev.source?.userId;
      if (!code || !to) continue;
      try {
        const { rows } = await deps.pool.query<{ org_name: string }>(
          `update notification_targets t set address = $2, link_code = null, link_expires_at = null, last_error = null
             from organizations o
            where o.id = t.org_id and t.link_code = $1 and t.link_expires_at > now()
           returning o.name as org_name`,
          [code, to],
        );
        if (rows[0]) await reply(ev.replyToken, `เชื่อมต่อกับ dotWatch แล้ว ✅\nจะได้รับแจ้งเตือนของ "${rows[0].org_name}" ที่นี่`);
        else await reply(ev.replyToken, "รหัสนี้ไม่ถูกต้องหรือหมดอายุแล้ว ขอรหัสใหม่ได้ที่หน้าตั้งค่าการแจ้งเตือนของ dotWatch");
      } catch (err) {
        const duplicate = (err as { code?: string }).code === "23505";
        await reply(ev.replyToken, duplicate ? "ห้องแชทนี้รับแจ้งเตือนขององค์กรนี้อยู่แล้ว" : "เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
        if (!duplicate) log.error("line link failed", { error: (err as Error).message });
      }
    }
  });
  return router;
}
