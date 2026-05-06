export type SecurityInvariantId =
  | "SEC-01"
  | "SEC-02"
  | "SEC-03"
  | "SEC-04"
  | "SEC-05"
  | "SEC-06"
  | "SEC-07"
  | "SEC-08"
  | "SEC-09"
  | "SEC-10"
  | "SEC-11";

export type SecurityGroupSlug =
  | "tenant"
  | "owner"
  | "oauth"
  | "secrets"
  | "impersonation"
  | "downloads"
  | "crypto"
  | "pipeline-cleanup"
  | "retention"
  | "audit"
  | "plans";

export type SecurityInvariantDefinition = {
  id: SecurityInvariantId;
  group: SecurityGroupSlug;
  marker: string;
  title: string;
};

export const SECURITY_INVARIANTS: readonly SecurityInvariantDefinition[] = [
  {
    id: "SEC-01",
    group: "tenant",
    marker: "TENANT_ISOLATION_OK",
    title: "Cross-workspace ID swapping cannot read or mutate resources"
  },
  {
    id: "SEC-02",
    group: "owner",
    marker: "OWNER_INVARIANT_OK",
    title: "Exactly one owner always preserved"
  },
  {
    id: "SEC-03",
    group: "oauth",
    marker: "OAUTH_VERIFIED_EMAIL_OK",
    title: "Unverified OAuth emails rejected"
  },
  {
    id: "SEC-04",
    group: "secrets",
    marker: "SECRET_NO_REVEAL_OK",
    title: "Saved secrets never reveal full value"
  },
  {
    id: "SEC-05",
    group: "impersonation",
    marker: "IMPERSONATION_DENY_OK",
    title: "Impersonation blocks downloads and secret changes"
  },
  {
    id: "SEC-06",
    group: "downloads",
    marker: "DOWNLOAD_TOKEN_OK",
    title: "Download tokens expire and reject replay or session mismatch"
  },
  {
    id: "SEC-07",
    group: "crypto",
    marker: "AEAD_TAMPER_OK",
    title: "Tampered encrypted backup fails AEAD verification"
  },
  {
    id: "SEC-08",
    group: "pipeline-cleanup",
    marker: "PIPELINE_CLEANUP_OK",
    title: "Partial or orphan backup objects cleaned or reconciled"
  },
  {
    id: "SEC-09",
    group: "retention",
    marker: "RETENTION_SCOPE_OK",
    title: "Retention deletes only scoped eligible objects"
  },
  {
    id: "SEC-10",
    group: "audit",
    marker: "AUDIT_COVERAGE_OK",
    title: "Sensitive actions write audit events"
  },
  {
    id: "SEC-11",
    group: "plans",
    marker: "PLAN_REQUEST_INVARIANT_OK",
    title: "Only one pending plan request per workspace"
  }
] as const;

export const SECURITY_GROUPS = [...new Set(SECURITY_INVARIANTS.map((item) => item.group))] as SecurityGroupSlug[];
