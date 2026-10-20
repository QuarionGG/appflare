import { describe, expect, it } from "vitest";
import {
  emdashUpgradeFilesSchema,
  emdashUpgradeRequestSchema,
  emdashVersionSatisfies,
} from "./emdash-upgrades";

describe("EmDash upgrade contracts", () => {
  it("enforces declared custom-plugin compatibility, including upper bounds", () => {
    expect(emdashVersionSatisfies("1.3.0", ">=1.1.0 <2")).toBe(true);
    expect(emdashVersionSatisfies("2.0.0", ">=1.1.0 <2")).toBe(false);
    expect(emdashVersionSatisfies("1.3.0", "not a version range")).toBeNull();
  });
  it("allows only the two unique dependency files", () => {
    const file = { path: "package.json", content: "{}" };
    expect(emdashUpgradeFilesSchema.safeParse([file, { ...file }]).success).toBe(false);
    expect(
      emdashUpgradeFilesSchema.safeParse([file, { path: "src/theme.astro", content: "changed" }])
        .success,
    ).toBe(false);
    expect(
      emdashUpgradeFilesSchema.safeParse([
        file,
        { path: "pnpm-lock.yaml", content: "lockfileVersion: 9" },
      ]).success,
    ).toBe(true);
  });
  it("requires a pinned source and stable target release", () => {
    const request = {
      protocol: 1,
      installId: "app1",
      runId: "run1",
      repo: "example/blog",
      baseSha: "a".repeat(40),
      targetVersion: "1.3.0",
    };
    expect(emdashUpgradeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      emdashUpgradeRequestSchema.safeParse({ ...request, targetVersion: "latest" }).success,
    ).toBe(false);
    expect(emdashUpgradeRequestSchema.safeParse({ ...request, baseSha: "main" }).success).toBe(
      false,
    );
    expect(
      emdashUpgradeRequestSchema.safeParse({ ...request, repo: "example/blog?token=x" }).success,
    ).toBe(false);
  });
});
