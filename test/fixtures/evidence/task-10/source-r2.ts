import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Authentically fetched immutable commit sources, not synthetic replacement text.
// Parent registration is still required before relocating other consumers.
export const ompSourceR2 = {
  root: join(import.meta.dir, "../task-39/qualified-source-v1"),
  relativeRoot: "task-39/qualified-source-v1",
  receipt: {
    path: join(import.meta.dir, "../task-39/qualified-source-v1/source-receipt.json"),
    sha256: "da9c0ae0602f9462250f3d144bcd93a4d2300bdda0ed1c8568d945ed870bb9b4",
  },
} as const;

export function verifyOmpSourceReceipt(): void {
  const body = readFileSync(ompSourceR2.receipt.path);
  if (createHash("sha256").update(body).digest("hex") !== ompSourceR2.receipt.sha256)
    throw new TypeError("fixture source receipt mismatch");
  const receipt: unknown = JSON.parse(body.toString());
  if (typeof receipt !== "object" || receipt === null || !("qualifiedRoot" in receipt)
    || receipt.qualifiedRoot !== ompSourceR2.relativeRoot || !("sourceRef" in receipt)
    || receipt.sourceRef !== "f446b8a8193e59b4cbd2cf487ab6fa1915e0b890")
    throw new TypeError("fixture source receipt identity mismatch");
}
