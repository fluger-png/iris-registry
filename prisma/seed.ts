import { prisma } from "../src/db.js";

const count = Number(process.env.SEED_COUNT ?? "1000");
if (!Number.isFinite(count) || count <= 0) {
  console.error("Invalid SEED_COUNT");
  process.exit(1);
}

const run = async () => {
  const data = [] as { iris_id: string; status: "available" }[];
  for (let i = 1; i <= count; i += 1) {
    data.push({ iris_id: `IRIS-${String(i).padStart(4, "0")}`, status: "available" });
  }

  await prisma.artwork.createMany({ data, skipDuplicates: true });
  console.log(`Seeded ${count} artworks (idempotent).`);
};

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
