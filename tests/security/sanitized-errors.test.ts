import { expect, test } from "bun:test";

import { createSanitizedError, redactForStructuredLog } from "../../packages/security/src";

test("sanitized error returns safe message and internal ref without leaking raw details", () => {
  const error = createSanitizedError(
    "source.operation_failed",
    "Request failed. Contact support with internal error reference.",
    new Error("mysqldump failed password=super-secret stdout=token-blob postgres://user:secret@db/internal")
  );

  expect(error.code).toBe("source.operation_failed");
  expect(error.message).toBe("Request failed. Contact support with internal error reference.");
  expect(error.internalErrorRef).toEqual(expect.any(String));
  expect(JSON.stringify(error)).not.toContain("super-secret");
  expect(JSON.stringify(error)).not.toContain("token-blob");
  expect(JSON.stringify(error)).not.toContain("postgres://");
});

test("structured log redaction removes secrets, tokens, and raw dump output", () => {
  const redacted = redactForStructuredLog({
    password: "leaky-secret",
    oauthAccessToken: "oauth-token-value",
    downloadToken: "download-token-value",
    dump: {
      argv: ["pg_dump", "--username=backup_user", "--password=leaky-secret"],
      stdout: "raw customer dump rows",
      stderr: "password=leaky-secret failed"
    },
    message: "postgres://backup_user:leaky-secret@db.internal/app password=leaky-secret token=oauth-token-value stdout=raw customer dump rows"
  });

  const serialized = JSON.stringify(redacted);
  expect(serialized).toContain("[REDACTED]");
  expect(serialized).not.toContain("leaky-secret");
  expect(serialized).not.toContain("oauth-token-value");
  expect(serialized).not.toContain("download-token-value");
  expect(serialized).not.toContain("raw customer dump rows");
  expect(serialized).not.toContain("postgres://backup_user");
});
