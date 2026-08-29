export type RemoteSourceMetadata = {
  sourceName: string;
  sourceType: string | null;
  remoteTableRef: string;
};

type DataSourceLike = {
  props?: {
    filename?: string | null;
    sourceName?: string | null;
    sourceType?: string | null;
    remoteTableRef?: string | null;
  };
};

export function inferSourceNameFromRemoteTableRef(remoteTableRef: string | null | undefined): string | null {
  const normalizedRemoteTableRef = remoteTableRef?.trim();
  if (!normalizedRemoteTableRef) {
    return null;
  }

  const dotIndex = normalizedRemoteTableRef.indexOf(".");
  if (dotIndex === -1) {
    return normalizedRemoteTableRef;
  }

  const sourceName = normalizedRemoteTableRef.slice(0, dotIndex).trim();
  return sourceName || null;
}

export function getRemoteTableDisplayName(remoteTableRef: string | null | undefined): string {
  const normalizedRemoteTableRef = remoteTableRef?.trim();
  if (!normalizedRemoteTableRef) {
    return "";
  }

  const parts = normalizedRemoteTableRef
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? normalizedRemoteTableRef;
}

export function getRemoteSourceMetadata(shape: DataSourceLike | null | undefined): RemoteSourceMetadata | null {
  const remoteTableRef = shape?.props?.remoteTableRef?.trim();
  if (!remoteTableRef) {
    return null;
  }

  const sourceName = shape?.props?.sourceName?.trim() || inferSourceNameFromRemoteTableRef(remoteTableRef);
  if (!sourceName) {
    return null;
  }

  const sourceType = shape?.props?.sourceType?.trim() || null;

  return {
    sourceName,
    sourceType,
    remoteTableRef,
  };
}

export function isRemoteDataSource(shape: DataSourceLike | null | undefined): boolean {
  return getRemoteSourceMetadata(shape) !== null;
}
