import type { CanvasNode } from "../types";

export function cardBaseHash(node: CanvasNode) {
  const payload = `${node.data.kind}\n${node.data.text ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
