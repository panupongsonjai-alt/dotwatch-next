import { log } from "../lib/log";
import type { Message } from "./messages";

/** A delivery failure. permanent = do not retry (bad address, revoked token, …). */
export class SendError extends Error {
  constructor(message: string, public permanent: boolean) {
    super(message);
  }
}

export interface Channel {
  /** false = no credentials; messages are written to the log instead (dry run). */
  configured: boolean;
  send(address: string, message: Message, retryKey: string): Promise<void>;
}

export type Channels = Record<"line" | "email", Channel>;

async function post(url: string, headers: Record<string, string>, body: unknown, okStatuses: number[] = []) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SendError(`network: ${(err as Error).message}`, false);
  }
  if (res.ok || okStatuses.includes(res.status)) return;
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  // 429 and 5xx are worth retrying; other 4xx will fail the same way again.
  throw new SendError(`HTTP ${res.status} ${detail}`, res.status !== 429 && res.status < 500);
}

/** LINE Messaging API push. 409 with the same retry key means LINE already accepted this message. */
export function lineChannel(accessToken: string): Channel {
  return {
    configured: accessToken.length > 0,
    async send(to, message, retryKey) {
      await post(
        "https://api.line.me/v2/bot/message/push",
        { authorization: `Bearer ${accessToken}`, "x-line-retry-key": retryKey },
        { to, messages: [{ type: "text", text: message.text.slice(0, 5000) }] },
        [409],
      );
    },
  };
}

/** Email through Resend's HTTP API. */
export function emailChannel(apiKey: string, from: string): Channel {
  return {
    configured: apiKey.length > 0 && from.length > 0,
    async send(to, message, retryKey) {
      await post(
        "https://api.resend.com/emails",
        { authorization: `Bearer ${apiKey}`, "idempotency-key": retryKey },
        { from, to: [to], subject: message.subject, text: message.text },
      );
    },
  };
}

/** Used when a channel has no credentials: shows exactly what would have been sent. */
export function logOnly(kind: string, message: Message, to: string) {
  log.info("notification (dry run, no credentials)", { channel: kind, to, text: message.text });
}
