// Acts like a board running the new firmware: samples every few seconds, sends batches,
// keeps unsent readings on network errors, drops readings the server rejected.
// Usage: npm run simulate -- [--sample 5] [--send 15] [--outage 60]
import { readFileSync } from "node:fs";
import type { IngestReading, IngestResponse } from "@dotwatch/shared";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const sampleSec = arg("sample", 5);
const sendSec = arg("send", 15);
const outageSec = arg("outage", 0);

const demo = JSON.parse(readFileSync(".demo-device.json", "utf8")) as { apiUrl: string; code: string; secret: string };
const queue: IngestReading[] = [];
const started = Date.now();
let temp = 4;

setInterval(() => {
  temp += (Math.random() - 0.5) * 0.4 + (4 - temp) * 0.05;
  queue.push({ t: Date.now(), m: { temperature: +temp.toFixed(2), humidity: +(60 + Math.random() * 5).toFixed(1) } });
  if (queue.length > 2000) queue.shift();
}, sampleSec * 1000);

setInterval(async () => {
  if (outageSec && Date.now() - started < outageSec * 1000) {
    console.log(`offline (simulated) — ${queue.length} readings queued`);
    return;
  }
  if (!queue.length) return;
  const batch = queue.slice(0, 500);
  try {
    const res = await fetch(`${demo.apiUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Device ${demo.code}:${demo.secret}` },
      body: JSON.stringify({ fw: "sim-0.1.0", readings: batch }),
    });
    if (!res.ok) {
      console.log(`server said ${res.status}: ${await res.text()}`);
      if (res.status === 400) queue.splice(0, batch.length); // malformed batch will never succeed
      return;
    }
    const body = (await res.json()) as IngestResponse;
    queue.splice(0, batch.length); // accepted or rejected: both leave the queue
    console.log(`sent ${batch.length} → accepted ${body.accepted}, rejected ${body.rejected.length}, last temp ${temp.toFixed(2)}`);
  } catch (err) {
    console.log(`network error, keeping ${queue.length} readings: ${(err as Error).message}`);
  }
}, sendSec * 1000);

console.log(`simulating ${demo.code}: sample ${sampleSec}s, send ${sendSec}s${outageSec ? `, outage first ${outageSec}s` : ""}`);
