import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@dotwatch/shared";
import { addDevice, get, post, resetDatabase, startTestServer, userWithOrg, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.pool.query("truncate org_invitations, notification_jobs, notification_targets, readings, latest, alarm_events, alarm_rules, devices, memberships, organizations, users cascade");
});

async function call(method: string, url: string, authorization: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", authorization }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** A shared org with an owner; returns helpers to invite and join people. */
async function sharedOrg() {
  const owner = await userWithOrg(env.pool, "olivia");
  const auth = `Bearer ${owner.token}`;
  const created = await post(`${env.url}/v1/orgs`, { name: "บริษัทห้องเย็น" }, auth);
  expect(created.status).toBe(201);
  const orgId = created.body.organization.id as string;
  const join = async (uid: string, role: string) => {
    await userWithOrg(env.pool, uid);
    const inv = await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: `${uid}@test.local`, role }, auth);
    expect(inv.status).toBe(201);
    const token = `Bearer dev:${uid}:${uid}@test.local`;
    expect((await post(`${env.url}/v1/invitations/${inv.body.invitation.id}/accept`, {}, token)).status).toBe(200);
    const me = await get(`${env.url}/v1/me`, token);
    return { token, id: me.body.id as string };
  };
  return { owner, auth, orgId, join };
}

describe("organizations and invitations", () => {
  it("invites by email, shows the invitation to that person only, and joins on accept", async () => {
    const { auth, orgId } = await sharedOrg();
    const inv = await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "Mike@Test.Local", role: "member" }, auth);
    expect(inv.body.invitation).toMatchObject({ email: "mike@test.local", role: "member", orgName: "บริษัทห้องเย็น" });

    const mike = "Bearer dev:mike:mike@test.local";
    const me = await get(`${env.url}/v1/me`, mike);
    expect(me.body.invitations.map((i: any) => i.orgName)).toEqual(["บริษัทห้องเย็น"]);
    expect(me.body.emailVerified).toBe(true);
    expect((await get(`${env.url}/v1/me`, "Bearer dev:otto:otto@test.local")).body.invitations).toEqual([]);
    expect((await post(`${env.url}/v1/invitations/${inv.body.invitation.id}/accept`, {}, "Bearer dev:otto:otto@test.local")).status).toBe(404);

    expect((await post(`${env.url}/v1/invitations/${inv.body.invitation.id}/accept`, {}, mike)).status).toBe(200);
    const after = await get(`${env.url}/v1/me`, mike);
    expect(after.body.invitations).toEqual([]);
    expect(after.body.organizations.find((o: any) => o.id === orgId)).toMatchObject({ role: "member" });

    const members = await get(`${env.url}/v1/orgs/${orgId}/members`, auth);
    expect(members.body.members.map((m: any) => [m.email, m.role])).toEqual([["olivia@test.local", "owner"], ["mike@test.local", "member"]]);
    expect((await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "mike@test.local", role: "viewer" }, auth)).status).toBe(409);
  });

  it("refuses invitations from members and owner invitations from admins", async () => {
    const { orgId, join } = await sharedOrg();
    const admin = await join("ada", "admin");
    const member = await join("mike", "member");
    expect((await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "x@test.local", role: "viewer" }, member.token)).status).toBe(403);
    expect((await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "x@test.local", role: "owner" }, admin.token)).status).toBe(403);
    expect((await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "x@test.local", role: "admin" }, admin.token)).status).toBe(201);
    expect((await get(`${env.url}/v1/orgs/${orgId}/members`, member.token)).body.invitations).toEqual([]);
  });

  it("changes roles, protects the last owner, and lets members leave", async () => {
    const { owner, auth, orgId, join } = await sharedOrg();
    const admin = await join("ada", "admin");
    const member = await join("mike", "member");
    const url = (id: string) => `${env.url}/v1/orgs/${orgId}/members/${id}`;

    expect((await call("PATCH", url(member.id), admin.token, { role: "viewer" })).status).toBe(200);
    expect((await call("PATCH", url(owner.user.id), admin.token, { role: "admin" })).status).toBe(403);
    expect((await call("PATCH", url(member.id), admin.token, { role: "owner" })).status).toBe(403);
    expect((await call("PATCH", url(owner.user.id), auth, { role: "admin" })).status).toBe(409); // last owner
    expect((await call("PATCH", url(admin.id), auth, { role: "owner" })).status).toBe(200);
    expect((await call("PATCH", url(owner.user.id), auth, { role: "admin" })).status).toBe(200); // now allowed

    expect((await call("DELETE", url(member.id), member.token)).status).toBe(204); // leave
    expect((await get(`${env.url}/v1/orgs/${orgId}/members`, member.token)).status).toBe(404);
    expect((await call("DELETE", url(owner.user.id), owner.token ? `Bearer ${owner.token}` : "")).status).toBe(204);
    const left = (await get(`${env.url}/v1/orgs/${orgId}/members`, admin.token)).body.members;
    expect(left.map((m: any) => m.role)).toEqual(["owner"]);
    // personal organization cannot be left
    expect((await call("DELETE", `${env.url}/v1/orgs/${owner.org.id}/members/${owner.user.id}`, auth)).status).toBe(409);
  });

  it("tells a removed member's open socket and stops sending them data", async () => {
    const { auth, orgId, join } = await sharedOrg();
    const member = await join("mike", "member");
    const ws = new WebSocket(env.wsUrl);
    const msgs: ServerMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: member.token.slice(7) }));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "subscribe", orgId }));
    await new Promise((r) => setTimeout(r, 150));
    expect(env.hub.stats().subscriptions).toBe(1);
    await call("DELETE", `${env.url}/v1/orgs/${orgId}/members/${member.id}`, auth);
    await new Promise((r) => setTimeout(r, 150));
    expect(msgs.some((m) => m.type === "membership" && m.orgId === orgId)).toBe(true);
    expect(env.hub.stats().subscriptions).toBe(0);
    ws.close();
  });

  it("moves a device with its rules, and deletes an empty organization", async () => {
    const { owner, auth, orgId } = await sharedOrg();
    const dev = await addDevice(env.pool, owner.org.id, "MOVE-1");
    await call("PUT", `${env.url}/v1/devices/${dev.id}/alarm-rules`, auth, { rules: [{ metric: "temperature", severity: "warning", max: 8 }] });
    await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 9 } }] }, dev.auth);

    expect((await call("DELETE", `${env.url}/v1/orgs/${orgId}`, auth)).status).toBe(204);
    const again = await post(`${env.url}/v1/orgs`, { name: "ทีมใหม่" }, auth);
    const newOrg = again.body.organization.id;
    const moved = await post(`${env.url}/v1/devices/${dev.id}/move`, { orgId: newOrg }, auth);
    expect(moved.body.device.orgId).toBe(newOrg);
    expect((await get(`${env.url}/v1/alarms?orgId=${newOrg}`, auth)).body.events).toHaveLength(1);
    expect((await get(`${env.url}/v1/devices?orgId=${owner.org.id}`, auth)).body.devices).toEqual([]);

    expect((await call("DELETE", `${env.url}/v1/orgs/${newOrg}`, auth)).status).toBe(409); // has a device
    expect((await call("DELETE", `${env.url}/v1/orgs/${owner.org.id}`, auth)).status).toBe(409); // personal
    const outsider = `Bearer ${(await userWithOrg(env.pool, "otto")).token}`;
    expect((await post(`${env.url}/v1/devices/${dev.id}/move`, { orgId: owner.org.id }, outsider)).status).toBe(404);
  });

  it("requires a verified email to accept", async () => {
    const { auth, orgId } = await sharedOrg();
    const inv = await post(`${env.url}/v1/orgs/${orgId}/invitations`, { email: "nina@test.local", role: "viewer" }, auth);
    await env.pool.query("insert into users (firebase_uid, email) values ('nina', 'nina@test.local')");
    // simulate an unverified Firebase user by calling the route through a token that lacks the email
    expect((await post(`${env.url}/v1/invitations/${inv.body.invitation.id}/accept`, {}, "Bearer dev:nina")).status).toBe(403);
  });
});
