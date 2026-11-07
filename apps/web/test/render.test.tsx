import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AlarmEvent, Device } from "@dotwatch/shared";
import { DeviceView } from "../src/components/DeviceView";
import { HistoryChart } from "../src/components/HistoryChart";
import { DevicePanel } from "../src/components/DevicePanel";

const device: Device = {
  id: "d1", orgId: "o1", code: "DEMO-001", name: "ห้องเย็น 1", lastSeenAt: 1000, firmwareVersion: "1.0", offlineAfterSec: 900, metrics: {},
  latest: { temperature: { time: 1000, value: 4.07 }, humidity: { time: 1000, value: 61 } },
};
const offline: AlarmEvent = {
  id: "e1", kind: "offline", orgId: "o1", deviceId: "d1", ruleId: null, metric: "connection", severity: "critical",
  min: null, max: null, startedAt: 0, startValue: null, endedAt: null, endValue: null, acknowledgedAt: null, acknowledgedBy: null,
};
const noop = () => {};

describe("render", () => {
  it("shows owners the settings and viewers a read-only page", () => {
    const owner = renderToStaticMarkup(<DeviceView device={device} role="owner" now={600_000} openAlarms={[offline]} onAck={async () => {}} onUpdated={noop} onDeleted={noop} />);
    expect(owner).toContain("ขาดการติดต่อ");
    expect(owner).toContain("ลบอุปกรณ์");
    const viewer = renderToStaticMarkup(<DeviceView device={device} role="viewer" now={600_000} openAlarms={[]} onAck={async () => {}} onUpdated={noop} onDeleted={noop} />);
    expect(viewer).not.toContain("ตั้งค่าอุปกรณ์");
    expect(viewer).toContain("ดูกฎแจ้งเตือน");
  });
  it("draws a chart with limits and a backfill note", () => {
    const t0 = 1_700_000_000_000;
    const pts = Array.from({ length: 50 }, (_, i) => ({ t: t0 + i * 60_000, avg: 4 + Math.sin(i / 5), min: 3.5, max: 5.2, n: 12, backfilled: i === 3 }));
    const html = renderToStaticMarkup(<HistoryChart metric="temperature" points={pts} bucketMs={60_000} from={t0} to={t0 + 3_600_000} limits={[{ value: 8, severity: "critical" }]} />);
    expect(html).toContain('<path class="line" d="M');
    expect(html).toContain("limit-critical");
    expect(html).toContain("ส่งตามมา");
  });
  it("links each card to its device page", () => {
    expect(renderToStaticMarkup(<DevicePanel device={device} now={2000} />)).toContain('href="#/devices/d1"');
  });
});

import { Invitations } from "../src/components/Invitations";
import { OrgPage } from "../src/components/OrgPage";
import type { Me } from "@dotwatch/shared";

describe("organization screens", () => {
  const me: Me = {
    id: "u1", email: "mike@example.com", displayName: "Mike", emailVerified: false,
    organizations: [{ id: "o1", name: "ส่วนตัว", personal: true, role: "owner" }],
    invitations: [{ id: "i1", orgId: "o2", orgName: "บริษัทห้องเย็น", email: "mike@example.com", role: "member", invitedBy: "Olivia", createdAt: 0, expiresAt: 1 }],
  };
  it("asks to verify the email before an invitation can be accepted", () => {
    const html = renderToStaticMarkup(<Invitations me={me} onJoined={noop} onChanged={noop} />);
    expect(html).toContain("ยืนยันอีเมล");
    expect(html).toContain("Olivia เชิญคุณเข้าร่วม <strong>บริษัทห้องเย็น</strong> ในบทบาทสมาชิก");
    expect(html).toMatch(/<button class="primary" disabled="">รับคำเชิญ/);
    expect(renderToStaticMarkup(<Invitations me={{ ...me, invitations: [] }} onJoined={noop} onChanged={noop} />)).toBe("");
  });
  it("hides delete and leave for a personal organization", () => {
    const html = renderToStaticMarkup(<OrgPage me={me} org={me.organizations[0]!} onChanged={noop} onSwitch={noop} />);
    expect(html).toContain("สร้างองค์กรใหม่");
    expect(html).not.toContain('class="danger"');
    expect(html).not.toContain("ออกจากองค์กร");
    expect(html).toContain("เชิญด้วยอีเมล");
  });
});

import { SignIn } from "../src/components/SignIn";
describe("sign in", () => {
  it("shows the dotWatch brand and the old headline", () => {
    const html = renderToStaticMarkup(<SignIn />);
    expect(html).toContain('<span class="logo" aria-hidden="true"></span><strong>dotWatch</strong>');
    expect(html).toContain("<h1>IoT Easy Monitoring</h1>");
  });
});
