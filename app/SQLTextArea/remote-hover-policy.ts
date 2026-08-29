export type RemoteHoverPolicy = "ask" | "auto";

const STORAGE_KEY = "kavla.remoteHoverColumnAnalysis.v1";

type StoredRemoteHoverPolicies = Record<string, RemoteHoverPolicy>;

function isRemoteHoverPolicy(value: unknown): value is RemoteHoverPolicy {
  return value === "ask" || value === "auto";
}

export function getRemoteHoverPolicyKey(sourceName: string | null | undefined, sourceType: string | null | undefined) {
  const normalizedSourceName = sourceName?.trim();
  if (!normalizedSourceName) {
    return null;
  }

  const normalizedSourceType = sourceType?.trim() || "remote";
  return `${normalizedSourceType}::${normalizedSourceName}`;
}

function readStoredRemoteHoverPolicies(): StoredRemoteHoverPolicies {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const nextPolicies: StoredRemoteHoverPolicies = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRemoteHoverPolicy(value)) {
        nextPolicies[key] = value;
      }
    }

    return nextPolicies;
  } catch (error) {
    console.error("Failed to read remote hover policy", error);
    return {};
  }
}

export function getRemoteHoverPolicy(
  sourceName: string | null | undefined,
  sourceType: string | null | undefined
): RemoteHoverPolicy {
  const key = getRemoteHoverPolicyKey(sourceName, sourceType);
  if (!key) {
    return "ask";
  }

  const policies = readStoredRemoteHoverPolicies();
  return policies[key] ?? "ask";
}

export function setRemoteHoverPolicy(
  sourceName: string | null | undefined,
  sourceType: string | null | undefined,
  policy: RemoteHoverPolicy
) {
  const key = getRemoteHoverPolicyKey(sourceName, sourceType);
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    const policies = readStoredRemoteHoverPolicies();
    policies[key] = policy;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(policies));
  } catch (error) {
    console.error("Failed to persist remote hover policy", error);
  }
}
