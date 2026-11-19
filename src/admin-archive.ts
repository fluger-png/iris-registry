import type { Prisma } from "@prisma/client";
import { CORE_AUTHOR_COLLECTION_SLUG, CORE_AUTHOR_OPTION_ID } from "./collaborator-access.js";

export const parseArchiveCollection = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : CORE_AUTHOR_OPTION_ID;

export const archiveCollectionScope = (selection: string): Prisma.ArtworkWhereInput =>
  selection === "all" ? {} : selection === CORE_AUTHOR_OPTION_ID || selection === CORE_AUTHOR_COLLECTION_SLUG
    ? { collection_id: null } : { collection_id: selection };

export const archiveHref = (selection: string, search = "", status = "all", page = 1, basePath = "/admin") => {
  const params = new URLSearchParams({ collection: selection });
  if (search) params.set("q", search);
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  return `${basePath}?${params}`;
};
