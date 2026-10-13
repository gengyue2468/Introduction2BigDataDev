export const AVERAGE_KEY = "average";

export function normalizeSelection(keys: "all" | Iterable<string | number>, visibleIds: Iterable<string | number>) {
  const visible = new Set([...visibleIds].map(String));
  return keys === "all" ? visible : new Set([...keys].map(String).filter((key) => visible.has(key)));
}

export function chartKeyForSelection(keys: ReadonlySet<string>) {
  return keys.size === 1 ? keys.values().next().value! : AVERAGE_KEY;
}
