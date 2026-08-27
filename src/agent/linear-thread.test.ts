import { describe, expect, it } from "vitest";
import { linearThreadParentId, shouldRetryLinearCommentWithoutParent } from "./linear-thread.js";

describe("linearThreadParentId", () => {
  it("uses the existing thread root when the mention is already a reply", () => {
    expect(
      linearThreadParentId({
        commentId: "edad4e55-b73e-4772-a706-34780ed323b3",
        parentCommentId: "7d6bfba8-4a3c-40e6-a3aa-598653726994",
      }),
    ).toBe("7d6bfba8-4a3c-40e6-a3aa-598653726994");
  });

  it("falls back to the triggering comment for a top-level mention", () => {
    expect(linearThreadParentId({ commentId: "comment-1" })).toBe("comment-1");
  });
});

describe("shouldRetryLinearCommentWithoutParent", () => {
  it("retries Linear incorrect parent the same way as a missing comment", () => {
    expect(shouldRetryLinearCommentWithoutParent("incorrect parent")).toBe(true);
    expect(shouldRetryLinearCommentWithoutParent("Entity not found: Comment")).toBe(true);
    expect(shouldRetryLinearCommentWithoutParent("rate limited")).toBe(false);
  });
});
