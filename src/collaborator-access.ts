import { Collection, Prisma, PrismaClient } from "@prisma/client";

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

export const collaboratorArtworkScope = (collections: Pick<Collection, "id">[]): Prisma.ArtworkWhereInput => ({
  // An empty grant list must return no works, never the core NULL collection.
  collection_id: { in: collections.map((collection) => collection.id) }
});
