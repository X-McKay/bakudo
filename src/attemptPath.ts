export const sanitizeAttemptPathSegment = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "attempt";
};

export const reservedGuestOutputDirForAttempt = (attemptId: string): string =>
  `/workspace/.bakudo/out/${sanitizeAttemptPathSegment(attemptId)}`;
