import { describe, expect, it, vi } from "vitest";
import { Collection, Prisma, PrismaClient } from "@prisma/client";
import { collaboratorArtworkScope, loadCollaboratorCollections, mergeCollaboratorCollections, parseCollectionIds, collectionArtworkId, collaboratorCollectionOptions } from "../src/collaborator-access.js";

const ararat = { id: "ararat", name: "Ararat Heart" } as Collection;
const sayat = { id: "sayat", name: "Sayat Nova" } as Collection;
const core = { id: "core-record", slug: "iris-the-unseen-edition", name: "IRIS" } as Collection;

describe("collection permissions", () => {
  it("parses repeated form fields without granting an implicit default", () => {
    expect(parseCollectionIds([" ararat ", "sayat", "ararat", null, 1, ""])).toEqual(["ararat", "sayat"]);
    expect(parseCollectionIds(undefined)).toEqual([]);
    expect(parseCollectionIds("ararat")).toEqual(["ararat"]);
  });

  it("preserves legacy access and deduplicates migrated permissions", () => {
    expect(mergeCollaboratorCollections(ararat, [sayat, ararat])).toEqual([ararat, sayat]);
  });

  it("never interprets an empty permission list as core or global access", () => {
    expect(collaboratorArtworkScope([])).toEqual({ collection_id: { in: [] } });
    expect(collaboratorArtworkScope([ararat, sayat])).toEqual({ collection_id: { in: ["ararat", "sayat"] } });
  });

  it("loads grants only for the authenticated user", async () => {
    const findMany = vi.fn().mockResolvedValue([{ collection: sayat }, { collection: ararat }]);
    const db = { collaboratorCollectionAccess: { findMany } } as unknown as PrismaClient;
    expect(await loadCollaboratorCollections(db, { id: "gugoco", collection: null })).toEqual([ararat, sayat]);
    expect(findMany).toHaveBeenCalledWith({ where: { user_id: "gugoco" }, include: { collection: true } });
  });

  it("includes legacy NULL inventory only with an explicit core grant", () => {
    expect(collaboratorArtworkScope([core])).toEqual({ collection_id: null });
    expect(collectionArtworkId(core)).toBeNull();
    expect(collectionArtworkId(ararat)).toBe("ararat");
    expect(collaboratorArtworkScope([core, ararat])).toEqual({ AND: [{ OR: [{ collection_id: null }, { collection_id: { in: ["ararat"] } }] }] });
  });

  it("offers core access without creating a record or duplicating an existing core entry", () => {
    expect(collaboratorCollectionOptions([ararat, sayat])).toContainEqual({ id: "__iris_core__", slug: core.slug, name: "IRIS - The Unseen Edition" });
    expect(collaboratorCollectionOptions([ararat, core]).map((item) => item.id)).toEqual(["ararat", "core-record"]);
  });

  it("keeps old accounts working before the additive migration without broadening access", async () => {
    const findMany = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "5" }));
    const db = { collaboratorCollectionAccess: { findMany } } as unknown as PrismaClient;
    expect(await loadCollaboratorCollections(db, { id: "old", collection: ararat })).toEqual([ararat]);
    expect(await loadCollaboratorCollections(db, { id: "new", collection: null })).toEqual([]);
  });

  it("does not silently ignore connection or permission errors", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const db = { collaboratorCollectionAccess: { findMany } } as unknown as PrismaClient;
    await expect(loadCollaboratorCollections(db, { id: "gugoco", collection: ararat })).rejects.toThrow("database unavailable");
  });
});
