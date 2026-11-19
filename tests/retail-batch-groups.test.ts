import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { numberRetailBatches, loadRetailBatchGroups, formatRetailBatchDate } from "../src/retail-stock.js";
import { archiveBatchScope, sortArchiveItemsByBatch } from "../src/admin-archive.js";
import { buildRetailStockBody } from "../src/retail-stock-pages.js";

describe("retail batch labels", () => {
  const a = { id: "OKG-FIRST", collection_id: "okg", created_at: new Date("2026-11-18T20:00:00Z") };
  const b = { id: "RANDOM-NAME", collection_id: "okg", created_at: new Date("2026-11-19T20:00:00Z") };
  const c = { id: "AR-FIRST", collection_id: "ararat", created_at: new Date("2026-11-19T21:00:00Z") };
  it("numbers within each collection by creation date, displays newest first, and does not mutate input", () => {
    const input = [b, a, c];
    expect(numberRetailBatches(input).map((batch) => [batch.id, batch.batch_number])).toEqual([[c.id, 1], [b.id, 2], [a.id, 1]]);
    expect(input).toEqual([b, a, c]);
    expect(numberRetailBatches([a, b, c, { ...b, id: "THIRD", created_at: new Date("2026-11-20T20:00:00Z") }]).find((batch) => batch.id === b.id)?.batch_number).toBe(2);
  });
  it("loads complete collection membership before any search or pagination", async () => {
    const findMany = vi.fn().mockResolvedValue([{ ...b, items: [{ iris_id: "OKG095" }] }, { ...a, items: [{ iris_id: "OKG004" }] }]);
    const db = { retailBatch: { findMany } } as unknown as PrismaClient;
    const groups = await loadRetailBatchGroups(db, "okg");
    expect(findMany.mock.calls[0][0].where).toEqual({ collection_id: "okg" });
    expect(groups.map((group) => [group.number, group.irisIds])).toEqual([[2, ["OKG095"]], [1, ["OKG004"]]]);
    expect(archiveBatchScope(groups, b.id)).toEqual({ iris_id: { in: ["OKG095"] } });
    expect(archiveBatchScope(groups, "__online__")).toEqual({ iris_id: { notIn: ["OKG095", "OKG004"] } });
    expect(archiveBatchScope(groups, "other-collection")).toBeNull();
    const rows = [{ iris_id: "ONLINE" }, { iris_id: "OKG004" }, { iris_id: "OKG095" }];
    expect(sortArchiveItemsByBatch(rows, groups, () => 0).map((row) => row.iris_id)).toEqual(["OKG095", "OKG004", "ONLINE"]);
  });
  it("renders numbered, dated batches in both admin and partner stock views", () => {
    const batches = [a, b].map((batch) => ({ ...batch, retailer: "OKG Jewelry", collection: { name: "OKG" }, items: [] }));
    for (const partner of [false, true]) {
      const html = buildRetailStockBody(batches as never, partner, "secret", (s) => s);
      expect(html.indexOf("Batch 2")).toBeLessThan(html.indexOf("Batch 1"));
      expect(html).toContain("Nov 19, 2026");
      expect(html).toContain(b.id);
    }
    expect(formatRetailBatchDate(new Date("2026-11-19T02:30:00Z"))).toContain("Nov 18, 2026");
  });
  it.each([[0.4, "0.40"], [0.416, "0.42"], [0, "0.00"], [null, "-"], [NaN, "-"], [Infinity, "-"]])(
    "renders gold weight %s in grams only in the partner stock table", (weight, expected) => {
      const batches = [{ ...a, retailer: "OKG Jewelry", collection: { name: "OKG" }, items: [{ iris_id: "OKG004", sold_at: null,
        artwork: { status: "retail_stock", image_url: null, owner_email: null, weight_grams: weight } }] }];
      const partner = buildRetailStockBody(batches as never, true, "secret", (s) => s);
      expect(partner).toContain("<th>IRIS</th><th>Gold weight (g)</th><th>Status</th>");
      expect(partner).toContain(`<td class="retail-weight">${expected}</td>`);
      const admin = buildRetailStockBody(batches as never, false, "secret", (s) => s);
      expect(admin).not.toContain("<th>Gold weight (g)</th>");
      expect(admin).not.toContain('<td class="retail-weight">');
    }
  );
});
