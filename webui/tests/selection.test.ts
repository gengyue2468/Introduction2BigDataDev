import { describe, expect, test } from "bun:test";
import { AVERAGE_KEY, chartKeyForSelection, normalizeSelection } from "../src/selection";

describe("dashboard selection", () => {
  test("select all uses the same string keys as every row", () => {
    const selected = normalizeSelection("all", [1, 2, 3]);
    expect([...selected]).toEqual(["1", "2", "3"]);
    expect(selected.has("2")).toBe(true);
  });

  test("individual keys are normalized and limited to the current platform/filter", () => {
    expect([...normalizeSelection(new Set([1, "2", "9"]), [1, 2])]).toEqual(["1", "2"]);
    expect([...normalizeSelection("all", [8, 9])]).toEqual(["8", "9"]);
  });

  test("single selection immediately focuses that product; multiple or none uses average", () => {
    expect(chartKeyForSelection(new Set(["2"]))).toBe("2");
    expect(chartKeyForSelection(new Set(["1", "2"]))).toBe(AVERAGE_KEY);
    expect(chartKeyForSelection(new Set())).toBe(AVERAGE_KEY);
    expect(chartKeyForSelection(normalizeSelection(["2"], [1, 2]))).toBe("2");
  });
});
