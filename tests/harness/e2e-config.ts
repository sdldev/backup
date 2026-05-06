import { FAKE_OAUTH_IDENTITIES } from "./fake-oauth";

export type E2EHarnessConfig = {
  browserName: "chromium";
  baseUrl: string;
  useRealExternalServices: false;
  oauthIdentities: typeof FAKE_OAUTH_IDENTITIES;
  flow: readonly string[];
};

export function createE2EHarnessConfig(): E2EHarnessConfig {
  return {
    browserName: "chromium",
    baseUrl: "http://127.0.0.1:4321",
    useRealExternalServices: false,
    oauthIdentities: FAKE_OAUTH_IDENTITIES,
    flow: ["oauth-mock", "workspace", "project", "source", "backup", "download", "invite"]
  };
}
