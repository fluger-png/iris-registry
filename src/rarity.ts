import crypto from "node:crypto";

export type RarityCode = "Common" | "Uncommon" | "Rare" | "Ultra Rare" | "Artist Edition";

export const RARITY_COUNTS: Array<{ code: RarityCode; count: number }> = [
  { code: "Common", count: 5000 },
  { code: "Uncommon", count: 3000 },
  { code: "Rare", count: 1500 },
  { code: "Ultra Rare", count: 400 },
  { code: "Artist Edition", count: 100 }
];

export const RARITY_CANONICAL_STRING = "Common,Uncommon,Rare,Ultra Rare,Artist Edition";

const sha256 = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex");

export const computeLeaf = (irisId: string, rarity: RarityCode, nonce: string): string => {
  return sha256(`${irisId}|${rarity}|${nonce}`);
};

export const hashPair = (a: string, b: string): string => {
  const [left, right] = a < b ? [a, b] : [b, a];
  return sha256(left + right);
};

export const buildMerkleTree = (leaves: string[]): string[][] => {
  if (leaves.length === 0) return [[]];
  const levels: string[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i];
      next.push(hashPair(left, right));
    }
    levels.push(next);
    current = next;
  }
  return levels;
};

export const getMerkleRoot = (levels: string[][]): string => {
  if (levels.length === 0) return "";
  const top = levels[levels.length - 1];
  return top[0] ?? "";
};

export const getMerkleProof = (levels: string[][], index: number): string[] => {
  const proof: string[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const pairIndex = idx ^ 1;
    const sibling = nodes[pairIndex] ?? nodes[idx];
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
};

export const verifyMerkleProof = (leaf: string, proof: string[], root: string): boolean => {
  let hash = leaf;
  for (const sibling of proof) {
    hash = hashPair(hash, sibling);
  }
  return hash === root;
};

export const shuffleWithSeed = <T>(list: T[], seed: string): T[] => {
  const out = list.slice();
  let state = sha256(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = sha256(state + i);
    const r = parseInt(state.slice(0, 8), 16) / 0xffffffff;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const buildRarityAssignments = (seed: string): Array<{
  irisId: string;
  rarity: RarityCode;
  nonce: string;
  leaf: string;
}> => {
  const ids: string[] = [];
  for (let i = 1; i <= 10000; i += 1) {
    ids.push(`IRIS-${String(i).padStart(4, "0")}`);
  }
  const shuffledIds = shuffleWithSeed(ids, seed);

  const rarityList: RarityCode[] = [];
  for (const entry of RARITY_COUNTS) {
    for (let i = 0; i < entry.count; i += 1) rarityList.push(entry.code);
  }
  if (rarityList.length !== 10000) throw new Error("rarity list must be 10000");

  const assignments: Array<{ irisId: string; rarity: RarityCode; nonce: string; leaf: string }> = [];
  for (let i = 0; i < shuffledIds.length; i += 1) {
    const irisId = shuffledIds[i];
    const rarity = rarityList[i];
    const nonce = sha256(`${seed}|${irisId}|${rarity}`).slice(0, 16);
    const leaf = computeLeaf(irisId, rarity, nonce);
    assignments.push({ irisId, rarity, nonce, leaf });
  }
  return assignments;
};
