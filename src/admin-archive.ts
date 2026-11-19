import type { Prisma } from "@prisma/client";
import { CORE_AUTHOR_COLLECTION_SLUG, CORE_AUTHOR_OPTION_ID } from "./collaborator-access.js";
import type { RetailBatchGroup } from "./retail-stock.js";

export const parseArchiveCollection = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : CORE_AUTHOR_OPTION_ID;

export const archiveCollectionScope = (selection: string): Prisma.ArtworkWhereInput =>
  selection === "all" ? {} : selection === CORE_AUTHOR_OPTION_ID || selection === CORE_AUTHOR_COLLECTION_SLUG
    ? { collection_id: null } : { collection_id: selection };

export const archiveHref = (selection: string, search = "", status = "all", page = 1, basePath = "/admin", batch = "") => {
  const params = new URLSearchParams({ collection: selection });
  if (search) params.set("q", search);
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  if (batch) params.set("batch", batch);
  return `${basePath}?${params}`;
};

export const archiveBatchScope = (batches: RetailBatchGroup[], selected: string): Prisma.ArtworkWhereInput | null => {
  if (!selected) return {};
  if (selected === "__online__") return { iris_id: { notIn: batches.flatMap((batch) => batch.irisIds) } };
  const batch = batches.find((item) => item.id === selected);
  return batch ? { iris_id: { in: batch.irisIds } } : null;
};

export const sortArchiveItemsByBatch = <T extends { iris_id: string }>(items: T[], batches: RetailBatchGroup[], compareOther: (a: T, b: T) => number): T[] => {
  const ranks = new Map(batches.flatMap((batch, index) => batch.irisIds.map((id) => [id, index] as const)));
  return [...items].sort((a, b) => {
    const rankA = ranks.get(a.iris_id) ?? batches.length;
    const rankB = ranks.get(b.iris_id) ?? batches.length;
    if (rankA !== rankB) return rankA - rankB;
    return rankA < batches.length ? a.iris_id.localeCompare(b.iris_id) : compareOther(a, b);
  });
};
