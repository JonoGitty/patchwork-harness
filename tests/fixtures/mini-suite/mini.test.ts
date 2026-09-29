import { describe, expect, it } from "vitest";

describe("mini suite", () => {
  it("passes", () => {
    expect(1 + 1).toBe(2);
  });
  it("fails deliberately", () => {
    // the reporter must record this as fail — a reporter that can only
    // write green is a defect
    expect(1 + 1).toBe(3);
  });
  it.skip("is skipped", () => {
    expect(true).toBe(false);
  });
});
