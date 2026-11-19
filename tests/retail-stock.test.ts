import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { createRetailBatch, markRetailSold, retailBatchCsv, retailCsrf, validRetailCsrf, loadRetailSoldIds, retailSchemaReady, retailEligibleWhere } from "../src/retail-stock.js";
import { purchasedArtworkWhere } from "../src/partner-collections.js";
vi.mock("../src/env.js", () => ({ env: {} }));

const tx = {
  $queryRaw: vi.fn(),
  retailBatch: { findUnique: vi.fn(), create: vi.fn(), count: vi.fn() },
  retailBatchItem: { findFirst: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  collection: { findUnique: vi.fn() }, artwork: { findMany: vi.fn(), updateMany: vi.fn() }, event: { create: vi.fn() }
};
const db = { ...tx, $transaction: vi.fn((fn) => fn(tx)) } as unknown as PrismaClient;
const request = { reference: "OKG-RETAIL-001", collectionId: "okg", retailer: "OKG Jewelry", quantity: 2, actor: "admin" };
const selected = [{ iris_id: "OKG089" }, { iris_id: "OKG014" }];
beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce(selected);
  tx.retailBatch.findUnique.mockResolvedValue(null);
  tx.retailBatch.create.mockResolvedValue({ id: request.reference, items: selected });
  tx.collection.findUnique.mockResolvedValue({ id: "okg" });
  tx.artwork.findMany.mockResolvedValue(selected.map((item) => ({ ...item, status: "available" })));
  tx.artwork.updateMany.mockResolvedValue({ count: 1 });
  tx.retailBatchItem.findFirst.mockResolvedValue({ iris_id: "OKG089", batch_id: request.reference, sold_at: null });
  tx.retailBatchItem.updateMany.mockResolvedValue({ count: 1 });
  tx.retailBatchItem.findMany.mockResolvedValue([]);
  tx.retailBatch.count.mockResolvedValue(1);
});

describe("retail allocation", () => {
  it("randomly locks existing eligible serials and excludes them from the online available pool", async () => {
    const backup = vi.fn();
    const result = await createRetailBatch(db, request, backup);
    expect(result.created).toBe(true);
    const sql = tx.$queryRaw.mock.calls[1][0].join("?");
    for (const text of ["ORDER BY random()", "FOR UPDATE OF a SKIP LOCKED", "a.\"status\" = 'available'", "NOT EXISTS", 'a."pin_code" IS NULL']) expect(sql).toContain(text);
    expect(backup.mock.invocationCallOrder[0]).toBeLessThan(tx.retailBatch.create.mock.invocationCallOrder[0]);
    expect(tx.artwork.updateMany).toHaveBeenCalledTimes(2);
    const updates = tx.artwork.updateMany.mock.calls;
    expect(updates.map(([arg]) => arg.where.iris_id)).toEqual(["OKG089", "OKG014"]);
    for (const [arg] of updates) {
      expect(arg.where.status).toBe("available");
      expect(arg.data).toEqual(expect.objectContaining({ status: "retail_stock", pin_code: expect.stringMatching(/^\d{6}$/), activation_token: expect.stringMatching(/^[a-f0-9]{32}$/) }));
      expect(arg.data.assigned_order_id).toBeUndefined();
      expect(arg.data.owner_email).toBeUndefined();
    }
    expect(updates[0][0].data.activation_token).not.toBe(updates[1][0].data.activation_token);
    expect(tx.event.create.mock.calls.every(([arg]) => arg.data.type === "retail_allocated")).toBe(true);
  });
  it("returns the original batch on retry without selecting or issuing credentials again", async () => {
    tx.retailBatch.findUnique.mockResolvedValue({ collection_id: "okg", retailer: request.retailer, items: selected });
    expect((await createRetailBatch(db, request)).created).toBe(false);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.artwork.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a reused reference with changed settings", async () => {
    tx.retailBatch.findUnique.mockResolvedValue({ collection_id: "other", retailer: request.retailer, items: selected });
    await expect(createRetailBatch(db, request)).rejects.toThrow("different settings");
    expect(tx.artwork.updateMany).not.toHaveBeenCalled();
  });
  it("does not allocate a partial batch or proceed without a successful backup", async () => {
    await expect(createRetailBatch(db, { ...request, quantity: 25 })).rejects.toThrow("No partial batch");
    expect(tx.retailBatch.create).not.toHaveBeenCalled();
    tx.$queryRaw.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce(selected);
    await expect(createRetailBatch(db, request, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(tx.artwork.updateMany).not.toHaveBeenCalled();
  });
  it("aborts the transaction on an allocation conflict", async () => {
    tx.artwork.updateMany.mockResolvedValue({ count: 0 });
    await expect(createRetailBatch(db, request)).rejects.toThrow("rolled back");
    expect(tx.event.create).not.toHaveBeenCalled();
  });
  it("allocates core IRIS only from the legacy NULL pool and uses the same eligibility rules for the counter", async () => {
    tx.collection.findUnique.mockResolvedValue({ id: "core", slug: "iris-the-unseen-edition" });
    await createRetailBatch(db, { ...request, collectionId: "core" });
    expect(tx.$queryRaw.mock.calls[1][1].sql).toBe('a."collection_id" IS NULL');
    expect(tx.retailBatch.create.mock.calls[0][0].data.collection_id).toBe("core");
    expect(retailEligibleWhere({ id: "core", slug: "iris-the-unseen-edition" })).toEqual(expect.objectContaining({ collection_id: null,
      status: "available", retail_entry: null, reservations: { none: { status: "active" } } }));
    expect(retailEligibleWhere({ id: "okg", slug: "the-art-of-adornment" }).collection_id).toBe("okg");
  });
});

describe("in-store sales", () => {
  it("requires a matching collection grant and records a sale without a fake Shopify order or buyer", async () => {
    await markRetailSold(db, "OKG089", ["okg"], "okg-user");
    expect(tx.retailBatchItem.findFirst).toHaveBeenCalledWith({ where: { iris_id: "OKG089", batch: { collection_id: { in: ["okg"] } } } });
    expect(tx.artwork.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "retail_stock" }), data: { status: "assigned" } }));
    expect(tx.retailBatchItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sold_by: "okg-user" }) }));
    expect(tx.event.create.mock.calls[0][0].data.type).toBe("retail_sold");
  });
  it("is idempotent and does not mutate another collection or an activated work", async () => {
    tx.retailBatchItem.findFirst.mockResolvedValueOnce(null);
    await expect(markRetailSold(db, "OKG089", ["ararat"], "other-user")).rejects.toThrow("not found");
    expect(tx.artwork.updateMany).not.toHaveBeenCalled();
    tx.retailBatchItem.findFirst.mockResolvedValueOnce({ sold_at: new Date() });
    expect(await markRetailSold(db, "OKG089", ["okg"], "okg-user")).toEqual({ alreadySold: true });
    expect(tx.artwork.updateMany).not.toHaveBeenCalled();
    tx.artwork.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(markRetailSold(db, "OKG089", ["okg"], "okg-user")).rejects.toThrow("status changed");
    expect(tx.event.create).not.toHaveBeenCalled();
  });
  it("signs sale actions per session and serial", () => {
    const csrf = retailCsrf("session", "OKG089");
    expect(validRetailCsrf(csrf, "session", "OKG089")).toBe(true);
    for (const [value, secret, serial] of [[csrf, "other", "OKG089"], [csrf, "session", "OKG014"], ["bad", "session", "OKG089"]]) {
      expect(validRetailCsrf(value, secret, serial)).toBe(false);
    }
  });
});

describe("retail labels and sales statistics", () => {
  it("exports stable PIN and NFC values without any reveal data", () => {
    const csv = retailBatchCsv([{ iris_id: "OKG089", pin_code: "123456", activation_token: "abc123" }], "https://irisnyc.store/");
    expect(csv).toBe('IRIS ID,PIN,NFC URL\r\n"OKG089","123456","https://irisnyc.store/pages/activate?token=abc123"');
    expect(() => retailBatchCsv([{ iris_id: "OKG089", pin_code: null, activation_token: "x" }], "https://irisnyc.store")).toThrow("Export stopped");
  });
  it("counts only recorded retail sales alongside online orders, not allocated stock", async () => {
    tx.retailBatchItem.findMany.mockResolvedValue([{ iris_id: "OKG014" }]);
    const ids = await loadRetailSoldIds(db, "okg");
    expect(tx.retailBatchItem.findMany.mock.calls[0][0].where.sold_at).toEqual({ not: null });
    expect(purchasedArtworkWhere("okg", ids)).toEqual({ collection_id: "okg", status: { in: ["assigned", "activated"] },
      OR: [{ assigned_order_id: { not: null } }, { iris_id: { in: ["OKG014"] } }] });
  });
  it("keeps existing pages working when the additive migration has not run yet", async () => {
    const missing = new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "test" });
    tx.retailBatchItem.findMany.mockRejectedValueOnce(missing);
    tx.retailBatch.count.mockRejectedValueOnce(missing);
    expect(await loadRetailSoldIds(db, "okg")).toEqual([]);
    expect(await retailSchemaReady(db)).toBe(false);
    tx.retailBatchItem.findMany.mockRejectedValueOnce(new Error("offline"));
    await expect(loadRetailSoldIds(db, "okg")).rejects.toThrow("offline");
  });
  it("includes sold retail core works in the main collection statistics", async () => {
    tx.retailBatchItem.findMany.mockResolvedValue([{ iris_id: "IRIS-1234" }]);
    expect(await loadRetailSoldIds(db, null)).toEqual(["IRIS-1234"]);
    expect(tx.retailBatchItem.findMany.mock.calls[0][0].where.batch).toEqual({ collection: { slug: "iris-the-unseen-edition" } });
  });
});
