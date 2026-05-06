import { SECURITY_GROUPS, SECURITY_INVARIANTS, type SecurityGroupSlug, type SecurityInvariantDefinition, type SecurityInvariantId } from "./ids";

function parseGroupArgs(value: string | undefined): SecurityGroupSlug[] {
  if (!value) {
    return SECURITY_GROUPS;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SecurityGroupSlug => SECURITY_GROUPS.includes(item as SecurityGroupSlug));

  return parsed.length > 0 ? parsed : SECURITY_GROUPS;
}

const activeGroups = new Set(parseGroupArgs(process.env.SECURITY_GROUPS));

export function getSecurityDefinitions(): readonly SecurityInvariantDefinition[] {
  return SECURITY_INVARIANTS;
}

export function shouldRunSecurityGroup(group: SecurityGroupSlug): boolean {
  return activeGroups.has(group);
}

export function getSecurityMarker(id: SecurityInvariantId): string {
  const match = SECURITY_INVARIANTS.find((item) => item.id === id);

  if (!match) {
    throw new Error(`Unknown security invariant id: ${id}`);
  }

  return match.marker;
}

export function formatSecurityList(): string {
  return SECURITY_INVARIANTS.map((item) => `${item.id} ${item.group} ${item.marker} ${item.title}`).join("\n");
}

export function createMarkerPrinter() {
  const seen = new Set<SecurityInvariantId>();

  return {
    print(id: SecurityInvariantId) {
      if (seen.has(id)) {
        return;
      }

      seen.add(id);
      console.log(getSecurityMarker(id));
    },
    finalize() {
      const missing = SECURITY_INVARIANTS.filter((item) => !seen.has(item.id));

      if (missing.length === 0) {
        console.log("SECURITY_INVARIANTS_OK");
      }
    }
  };
}
