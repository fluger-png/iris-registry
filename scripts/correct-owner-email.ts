import { prisma } from "../src/db.js";

const args = process.argv.slice(2);

const getArg = (flag: string): string | null => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
};

const hasFlag = (flag: string): boolean => args.includes(flag);

const required = (flag: string): string => {
  const value = getArg(flag);
  if (!value?.trim()) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value.trim();
};

const normalizeIrisId = (value: string): string => {
  const clean = value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (/^\d+$/.test(clean)) {
    return `IRIS-${clean.padStart(4, "0")}`;
  }
  return clean.startsWith("IRIS-") ? clean : `IRIS-${clean}`;
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const irisId = normalizeIrisId(required("--iris-id"));
const expectedCurrentOwner = normalizeEmail(required("--from"));
const nextOwner = normalizeEmail(required("--to"));
const reason =
  getArg("--reason")?.trim() || "Owner email corrected after customer registration typo";
const dryRun = hasFlag("--dry-run");

const run = async () => {
  const artwork = await prisma.artwork.findUnique({
    where: { iris_id: irisId },
    select: {
      iris_id: true,
      status: true,
      owner_email: true,
      assigned_customer_email: true
    }
  });

  if (!artwork) {
    throw new Error(`Artwork not found: ${irisId}`);
  }

  const currentOwner = artwork.owner_email?.trim().toLowerCase() ?? "";
  if (currentOwner !== expectedCurrentOwner) {
    throw new Error(
      `${irisId} owner mismatch. Expected ${expectedCurrentOwner}, found ${currentOwner || "empty"}.`
    );
  }

  if (currentOwner === nextOwner) {
    console.log(`${irisId} already belongs to ${nextOwner}.`);
    return;
  }

  if (dryRun) {
    console.log(
      `[dry-run] ${irisId}: owner ${currentOwner} -> ${nextOwner}; status=${artwork.status}; buyer=${
        artwork.assigned_customer_email ?? "-"
      }`
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.artwork.update({
      where: { iris_id: irisId },
      data: { owner_email: nextOwner }
    });

    await tx.event.create({
      data: {
        iris_id: irisId,
        type: "owner_email_corrected",
        actor: "support",
        payload_json: {
          previous_owner_email: currentOwner,
          corrected_owner_email: nextOwner,
          assigned_customer_email: artwork.assigned_customer_email,
          reason
        }
      }
    });
  });

  console.log(`Updated ${irisId} owner from ${currentOwner} to ${nextOwner}.`);
};

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
