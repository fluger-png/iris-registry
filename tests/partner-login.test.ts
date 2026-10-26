import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

const db = vi.hoisted(() => ({
  collaboratorUser: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  collaboratorCollectionAccess: { findMany: vi.fn() },
  collaboratorSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  collaboratorInvite: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  collection: { findMany: vi.fn(), create: vi.fn() },
  artwork: { groupBy: vi.fn() },
  $transaction: vi.fn(), $disconnect: vi.fn()
}));

vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/env.js", () => ({ env: {
  adminBasicUser: "test-admin", adminBasicPass: "test-password", adminTimezone: "America/New_York",
  baseUrl: "https://partner.test", partnerPortalBaseUrl: "https://partner.test",
  partnerInviteTtlHours: 24, partnerSessionTtlDays: 30, releaseIntervalMinutes: 60,
  r2AccountId: "test", r2AccessKeyId: "test", r2SecretAccessKey: "test",
  resendApiKey: "", resendFromEmail: ""
} }));

import { createServer } from "../src/server.js";

const ararat = { id: "ararat", slug: "ararat-heart", name: "Ararat Heart", edition_size: 100, status: "active" };
const sayat = { id: "sayat", slug: "sayat-nova", name: "Sayat Nova", edition_size: 100, status: "active" };
const salt = Buffer.from("partner-test-salt");
const password = "collection-password";
const passwordHash = `${salt.toString("hex")}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
const user = { id: "gugoco", email: "partner@example.test", full_name: "Gugoco", status: "active", password_hash: passwordHash, collection: null };
const auth = { authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` };
const form = { "content-type": "application/x-www-form-urlencoded" };
let app: FastifyInstance;

beforeEach(async () => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((fn) => fn(db));
  db.collection.findMany.mockResolvedValue([ararat, sayat]);
  db.collaboratorCollectionAccess.findMany.mockResolvedValue([{ collection: ararat }, { collection: sayat }]);
  db.collaboratorUser.findUnique.mockResolvedValue(user);
  db.collaboratorUser.create.mockResolvedValue({ ...user, status: "invited" });
  db.collaboratorSession.findFirst.mockResolvedValue({ id: "session", user });
  db.collaboratorInvite.findFirst.mockResolvedValue({
    id: "invite", accepted_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000),
    user: { ...user, status: "invited" }
  });
  db.collaboratorInvite.updateMany.mockResolvedValue({ count: 1 });
  db.artwork.groupBy.mockResolvedValue([
    { collection_id: "ararat", _count: { _all: 3 } },
    { collection_id: "sayat", _count: { _all: 4 } }
  ]);
  app = await createServer();
});

afterEach(async () => { await app.close(); });

describe("partner access routes", () => {
  it("redirects an anonymous visitor without reading inventory", async () => {
    const response = await app.inject({ method: "GET", url: "/partner" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/partner/login");
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("creates one user with two explicit grants, no new collection or artwork", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Gugoco&email=PARTNER%40example.test&collection_ids=ararat&collection_ids=sayat" });
    expect(response.statusCode).toBe(200);
    expect(db.collection.create).not.toHaveBeenCalled();
    expect(db.collaboratorUser.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      email: "partner@example.test", collection_id: null,
      collection_access: { create: [{ collection_id: "ararat" }, { collection_id: "sayat" }] }
    }) });
    expect(db.collaboratorInvite.create).toHaveBeenCalledTimes(1);
    expect(db.collaboratorSession.deleteMany).toHaveBeenCalledWith({ where: { user_id: "gugoco" } });
    expect(response.body).toContain("Ararat Heart, Sayat Nova");
  });

  it("rejects granting an unknown collection", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Gugoco&email=partner%40example.test&collection_ids=unseen" });
    expect(response.statusCode).toBe(400);
    expect(db.collaboratorUser.create).not.toHaveBeenCalled();
  });

  it("keeps the existing single draft collection creation flow", async () => {
    db.collection.create.mockResolvedValue(ararat);
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...auth, ...form },
      payload: "full_name=Artist&email=artist%40example.test&collection_name=Ararat&edition_size=100" });
    expect(response.statusCode).toBe(200);
    expect(db.collection.create).toHaveBeenCalledTimes(1);
    const data = db.collaboratorUser.create.mock.calls[0][0].data;
    expect(data.collection_id).toBe("ararat");
    expect(data.collection_access).toBeUndefined();
  });

  it("does not allow partner cookies to grant admin privileges", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/collaborators", headers: { ...form, cookie: "iris_partner_session=test" }, payload: "full_name=Bad" });
    expect(response.statusCode).toBe(401);
    expect(db.collaboratorUser.create).not.toHaveBeenCalled();
  });

  it("logs in a multi-collection account with no legacy primary collection", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: `email=PARTNER%40example.test&password=${password}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/partner");
    expect(response.headers["set-cookie"]).toEqual(expect.stringContaining("HttpOnly"));
    expect(response.headers["set-cookie"]).toEqual(expect.stringContaining("Secure"));
    expect(db.collaboratorSession.create).toHaveBeenCalledTimes(1);
  });

  it("rejects incorrect passwords and disabled accounts", async () => {
    const bad = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: "email=partner%40example.test&password=wrong" });
    expect(bad.statusCode).toBe(401);
    db.collaboratorUser.findUnique.mockResolvedValue({ ...user, status: "disabled" });
    const disabled = await app.inject({ method: "POST", url: "/partner/login", headers: form, payload: `email=partner%40example.test&password=${password}` });
    expect(disabled.statusCode).toBe(401);
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("scopes dashboard counts to Gugoco despite a forged collection query", async () => {
    const response = await app.inject({ method: "GET", url: "/partner?collection=unseen&user_id=other", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Ararat Heart");
    expect(response.body).toContain("Sayat Nova");
    expect(response.body).not.toContain("The Unseen Edition");
    expect(db.artwork.groupBy).toHaveBeenCalledWith({
      by: ["collection_id"], where: { collection_id: { in: ["ararat", "sayat"] }, status: "activated" }, _count: { _all: true }
    });
  });

  it("never reads all inventory when grants are empty", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "GET", url: "/partner", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("No collections assigned");
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("does not issue a session to an account with no collection permissions", async () => {
    db.collaboratorCollectionAccess.findMany.mockResolvedValue([]);
    const response = await app.inject({ method: "POST", url: "/partner/login", headers: form,
      payload: `email=partner%40example.test&password=${password}` });
    expect(response.statusCode).toBe(401);
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a disabled account's existing session", async () => {
    db.collaboratorSession.findFirst.mockResolvedValue({ id: "session", user: { ...user, status: "disabled" } });
    const response = await app.inject({ method: "GET", url: "/partner", headers: { cookie: "iris_partner_session=test" } });
    expect(response.statusCode).toBe(302);
    expect(db.artwork.groupBy).not.toHaveBeenCalled();
  });

  it("shows both collections on the single invitation", async () => {
    const response = await app.inject({ method: "GET", url: "/partner/invite/test-token" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Ararat Heart, Sayat Nova");
  });

  it("accepts an invitation once and removes old sessions", async () => {
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(302);
    expect(db.collaboratorInvite.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      id: "invite", accepted_at: null, revoked_at: null, user: { status: "invited" }
    }), data: expect.any(Object) });
    expect(db.collaboratorSession.deleteMany).toHaveBeenCalledWith({ where: { user_id: "gugoco" } });
  });

  it("rejects an invitation lost to a concurrent acceptance", async () => {
    db.collaboratorInvite.updateMany.mockResolvedValue({ count: 0 });
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
    expect(db.collaboratorSession.create).not.toHaveBeenCalled();
  });

  it("rejects expired invitations without changing users", async () => {
    db.collaboratorInvite.findFirst.mockResolvedValue({ id: "expired", user: { ...user, status: "invited" }, expires_at: new Date(0) });
    const response = await app.inject({ method: "POST", url: "/partner/invite/expired", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
  });

  it("does not reactivate a disabled user via an old invitation", async () => {
    db.collaboratorInvite.findFirst.mockResolvedValue({ id: "invite", accepted_at: null,
      expires_at: new Date(Date.now() + 60_000), user: { ...user, status: "disabled" } });
    const response = await app.inject({ method: "POST", url: "/partner/invite/test-token", headers: form,
      payload: `password=${password}&password_confirm=${password}` });
    expect(response.statusCode).toBe(410);
    expect(db.collaboratorUser.update).not.toHaveBeenCalled();
  });
});
