import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import {
  buildRarityAssignments,
  buildMerkleTree,
  getMerkleProof,
  getMerkleRoot,
  RARITY_CANONICAL_STRING
} from "../src/rarity.js";

const seed = process.env.RARITY_SEED ?? "";
if (!seed) {
  console.error("Missing RARITY_SEED env var for deterministic rarity generation");
  process.exit(1);
}

const assignments = buildRarityAssignments(seed);
const leaves = assignments.map((a) => a.leaf);
const tree = buildMerkleTree(leaves);
const root = getMerkleRoot(tree);

const rootRecord = {
  root,
  total: assignments.length,
  rarity_counts: RARITY_CANONICAL_STRING
};

const run = async () => {
  console.log(`Rarity merkle root: ${root}`);

  for (let i = 0; i < assignments.length; i += 1) {
    const { irisId, rarity, nonce } = assignments[i];
    const proof = getMerkleProof(tree, i);
    await prisma.artwork.update({
      where: { iris_id: irisId },
      data: {
        rarity_code: rarity,
        rarity_proof: {
          nonce,
          proof,
          root
        }
      }
    });
  }

  await prisma.event.create({
    data: {
      iris_id: "IRIS-0001",
      type: "rarity_merkle_root",
      actor: "system",
      payload_json: rootRecord
    }
  });

  const releaseTemplatePath = path.resolve("src/rarity-release.md");
  if (fs.existsSync(releaseTemplatePath)) {
    const template = fs.readFileSync(releaseTemplatePath, "utf8");
    const rendered = template.replace("{{ROOT}}", root);
    fs.writeFileSync(path.resolve("rarity-release.generated.md"), rendered);
  }

  fs.writeFileSync(path.resolve("rarity-root.json"), JSON.stringify(rootRecord, null, 2));

  console.log("Rarity assignments complete.");
  console.log("Generated rarity-release.generated.md and rarity-root.json");
};

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
