import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const pad = (value: number) => value.toString().padStart(4, "0");

const run = async () => {
  const data = Array.from({ length: 1000 }, (_, index) => {
    const irisId = `IRIS-${pad(index + 1)}`;
    return {
      iris_id: irisId,
      status: "available" as const
    };
  });

  await prisma.artwork.createMany({
    data,
    skipDuplicates: true
  });
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
