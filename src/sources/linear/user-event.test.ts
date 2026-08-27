import { describe, expect, it } from "vitest";
import {
  InvalidLinearUserEventError,
  isPrivilegedLinearUserEvent,
  linearUserEventToWakeEvent,
} from "./user-event.js";

const pins = {
  sourceId: "webhook-linear",
  expectedUserId: "chip-user",
  expectedOrganizationId: "snap-org",
  signedBodyDeliveryId: "linear-body-digest",
};

function base(type: "Comment" | "Issue") {
  return {
    action: "create",
    type,
    organizationId: "snap-org",
    createdAt: "2026-07-28T12:00:00.000Z",
    actor: {
      id: "cj-user",
      name: "CJ Lazell",
      email: "cj@snapcorp.com",
    },
    url: "https://linear.app/snap/issue/ENG-1/test",
  };
}

describe("linearUserEventToWakeEvent", () => {
  it("accepts exact @chip and @Chip Byte comments from the signed actor", () => {
    for (const body of ["@chip please fix this", "Can you handle this, @Chip Byte?"]) {
      const event = linearUserEventToWakeEvent({
        ...pins,
        body: {
          ...base("Comment"),
          data: {
            id: "comment-1",
            issueId: "issue-1",
            userId: "cj-user",
            body,
            issue: { id: "issue-1", identifier: "ENG-1", title: "Test" },
          },
        },
      });

      expect(event?.kind).toBe("LinearUserEvent.mention");
      expect(event?.principal?.subjectId).toBe("cj-user");
      expect(event?.conversation?.replyTarget).toBe("issue-1");
      expect(event?.payload.commentId).toBe("comment-1");
      expect(event?.payload.parentCommentId).toBeUndefined();
      expect(event && isPrivilegedLinearUserEvent(event)).toBe(true);
    }
  });

  it("stamps parentCommentId when the mention is already a thread reply", () => {
    const event = linearUserEventToWakeEvent({
      ...pins,
      body: {
        ...base("Comment"),
        data: {
          id: "edad4e55-b73e-4772-a706-34780ed323b3",
          parentId: "7d6bfba8-4a3c-40e6-a3aa-598653726994",
          issueId: "issue-1",
          userId: "cj-user",
          body: "@chip put the plan in the description",
          issue: { id: "issue-1", identifier: "ENG-4673", title: "Test" },
        },
      },
    });

    expect(event?.payload.commentId).toBe("edad4e55-b73e-4772-a706-34780ed323b3");
    expect(event?.payload.parentCommentId).toBe("7d6bfba8-4a3c-40e6-a3aa-598653726994");
  });

  it("accepts a new assignment to the pinned Chip user", () => {
    const event = linearUserEventToWakeEvent({
      ...pins,
      body: {
        ...base("Issue"),
        action: "update",
        data: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Test",
          assigneeId: "chip-user",
        },
        updatedFrom: { assigneeId: "someone-else" },
      },
    });

    expect(event?.kind).toBe("LinearUserEvent.assignment");
    expect(event?.payload.body).toBe("Work on the Linear issue assigned to Chip.");
    expect(event && isPrivilegedLinearUserEvent(event)).toBe(true);
  });

  it("rejects lookalikes, stale description mentions, and unrelated assignments", () => {
    const lookalike = linearUserEventToWakeEvent({
      ...pins,
      body: {
        ...base("Comment"),
        data: {
          id: "comment-1",
          issueId: "issue-1",
          userId: "cj-user",
          body: "@chipmunk please fix this",
        },
      },
    });
    const stale = linearUserEventToWakeEvent({
      ...pins,
      body: {
        ...base("Issue"),
        action: "update",
        data: { id: "issue-1", description: "@chip old request" },
        updatedFrom: { title: "Old title" },
      },
    });
    const otherAssignee = linearUserEventToWakeEvent({
      ...pins,
      body: {
        ...base("Issue"),
        action: "update",
        data: { id: "issue-1", assigneeId: "someone-else" },
        updatedFrom: { assigneeId: null },
      },
    });

    expect(lookalike).toBeNull();
    expect(stale).toBeNull();
    expect(otherAssignee).toBeNull();
  });

  it("fails closed on conflicting or unpinned identity", () => {
    expect(() =>
      linearUserEventToWakeEvent({
        ...pins,
        body: {
          ...base("Comment"),
          data: {
            id: "comment-1",
            issueId: "issue-1",
            userId: "different-user",
            body: "@chip do this",
          },
        },
      }),
    ).toThrow(InvalidLinearUserEventError);

    expect(
      linearUserEventToWakeEvent({
        ...pins,
        expectedUserId: undefined,
        body: base("Comment"),
      }),
    ).toBeNull();
  });
});
