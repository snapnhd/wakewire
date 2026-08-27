/** Linear comments are 2-level only. GraphQL parentId must be the thread root. */
export function linearThreadParentId(payload: {
  parentCommentId?: unknown;
  commentId?: unknown;
}): string {
  const parent = typeof payload.parentCommentId === "string" ? payload.parentCommentId.trim() : "";
  const comment = typeof payload.commentId === "string" ? payload.commentId.trim() : "";
  return parent || comment;
}

export function shouldRetryLinearCommentWithoutParent(errorText: string): boolean {
  return /entity not found:\s*comment/i.test(errorText) || /incorrect parent/i.test(errorText);
}
