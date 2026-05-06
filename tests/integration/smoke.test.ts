import { expect, test } from "bun:test";
import { buildApiBasePath } from "../../apps/api/src/app";

test("integration scaffold: api module loads", () => {
  expect(buildApiBasePath()).toBe("/v1");
});
