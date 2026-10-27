import { Collection, Prisma, PrismaClient } from "@prisma/client";

export const CORE_AUTHOR_COLLECTION_SLUG = "iris-the-unseen-edition";
export const CORE_AUTHOR_OPTION_ID = "__iris_core__";
export const CORE_AUTHOR_COLLECTION_NAME = "IRIS - The Unseen Edition";

export const isCoreAuthorCollection = (collection: Pick<Collection, "slug">) => collection.slug === CORE_AUTHOR_COLLECTION_SLUG;
export const collectionArtworkId = (collection: Pick<Collection, "id" | "slug">): string | null =>
  isCoreAuthorCollection(collection) ? null : collection.id;

export const collaboratorCollectionOptions = (collections: Pick<Collection, "id" | "name" | "slug">[]) =>
  (collections.some(isCoreAuthorCollection) ? collections : [...collections, {
    id: CORE_AUTHOR_OPTION_ID, name: CORE_AUTHOR_COLLECTION_NAME, slug: CORE_AUTHOR_COLLECTION_SLUG
  }]).sort((a, b) => a.name.localeCompare(b.name));

export const parseCollectionIds = (input: unknown): string[] => {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.filter((value): value is string => typeof value === "string")
    .map((value) => value.trim()).filter(Boolean))];
};

export const mergeCollaboratorCollections = (
  legacy: Collection | null,
  granted: Collection[]
): Collection[] => [...new Map([
  ...(legacy ? [legacy] : []), ...granted
].map((collection) => [collection.id, collection])).values()]
  .sort((a, b) => a.name.localeCompare(b.name));

export const loadCollaboratorCollections = async (
  db: PrismaClient,
  user: { id: string; collection: Collection | null }
): Promise<Collection[]> => {
  try {
    const access = await db.collaboratorCollectionAccess.findMany({
      where: { user_id: user.id },
      include: { collection: true }
    });
    return mergeCollaboratorCollections(user.collection, access.map((item) => item.collection));
  } catch (error) {
    // A rolling deployment must not break existing single-collection logins.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      return mergeCollaboratorCollections(user.collection, []);
    }
    throw error;
  }
};

export const collaboratorArtworkScope = (collections: Pick<Collection, "id" | "slug">[]): Prisma.ArtworkWhereInput => {
  const hasCore = collections.some(isCoreAuthorCollection);
  const ids = collections.filter((collection) => !isCoreAuthorCollection(collection)).map((collection) => collection.id);
  // Only an explicit core grant includes legacy NULL works. Keep OR inside AND so search cannot override access.
  if (hasCore && ids.length) return { AND: [{ OR: [{ collection_id: null }, { collection_id: { in: ids } }] }] };
  return { collection_id: hasCore ? null : { in: ids } };
};
