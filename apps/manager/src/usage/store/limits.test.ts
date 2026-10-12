import { describe, expect, it } from "vitest";
import { chunk, dayStart, hourStart, rowsPerStatement, toUnixSeconds } from "./limits";

describe("usage store limits", () => {
  it("cuts lists into runs, the last one shorter", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it("fits rows under D1's 100 bound parameters", () => {
    expect(rowsPerStatement(4)).toBe(25);
    expect(rowsPerStatement(7)).toBe(14);
  });

  it("finds the UTC hour and day an instant falls in", () => {
    const t = toUnixSeconds(Date.UTC(2026, 9, 12, 13, 45, 12, 999));
    expect(t).toBe(Date.UTC(2026, 9, 12, 13, 45, 12) / 1000);
    expect(hourStart(t)).toBe(Date.UTC(2026, 9, 12, 13) / 1000);
    expect(dayStart(t)).toBe(Date.UTC(2026, 9, 12) / 1000);
  });
});
