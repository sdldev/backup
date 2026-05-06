export type FakeOAuthProvider = "google" | "github";

export type FakeOAuthIdentity = {
  provider: FakeOAuthProvider;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string;
};

export const FAKE_OAUTH_IDENTITIES: readonly FakeOAuthIdentity[] = [
  {
    provider: "google",
    providerAccountId: "google-agency-a-owner",
    email: "agency-a@example.com",
    emailVerified: true,
    name: "Agency A Owner"
  },
  {
    provider: "github",
    providerAccountId: "github-agency-b-owner",
    email: "agency-b@example.com",
    emailVerified: true,
    name: "Agency B Owner"
  },
  {
    provider: "google",
    providerAccountId: "google-unverified-member",
    email: "pending-member@example.com",
    emailVerified: false,
    name: "Pending Member"
  }
] as const;

export function resolveFakeOAuthIdentity(provider: FakeOAuthProvider, email: string): FakeOAuthIdentity {
  const identity = FAKE_OAUTH_IDENTITIES.find((item) => item.provider === provider && item.email === email);

  if (!identity) {
    throw new Error(`Unknown fake OAuth identity for ${provider}:${email}`);
  }

  return identity;
}

export function assertVerifiedFakeOAuthIdentity(identity: FakeOAuthIdentity): FakeOAuthIdentity {
  if (!identity.emailVerified) {
    throw new Error(`Fake OAuth identity ${identity.email} is not verified`);
  }

  return identity;
}
