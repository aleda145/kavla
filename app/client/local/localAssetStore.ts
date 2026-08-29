import type { TLAssetStore } from "tldraw";
import { getActiveLocalSession, getSessionBlobUrl, stageSessionBlob } from "./localSession";

function assetBlobId(assetId: string): string {
  return `asset:${assetId}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read local asset"));
    reader.onabort = () => reject(new Error("Local asset read was cancelled"));
    reader.readAsDataURL(blob);
  });
}

export const localAssetStore: TLAssetStore = {
  async upload(asset, file) {
    if (!getActiveLocalSession()) {
      return { src: await blobToDataUrl(file) };
    }

    const blobId = assetBlobId(asset.id);
    await stageSessionBlob({
      id: blobId,
      kind: "asset",
      shapeId: asset.id,
      file,
    });
    return { src: getSessionBlobUrl(blobId) };
  },

  resolve(asset) {
    const descriptor = getActiveLocalSession()?.blobs.find(
      (blob) => blob.kind === "asset" && blob.shapeId === asset.id
    );
    if (descriptor) {
      return getSessionBlobUrl(descriptor.id);
    }
    return asset.props.src;
  },

  async remove(assetIds) {
    if (!getActiveLocalSession()) return;

    await Promise.all(
      assetIds.map(async (assetId) => {
        const response = await fetch(`/api/session/blobs/${encodeURIComponent(assetBlobId(assetId))}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Could not remove bundled asset ${assetId} (status ${response.status})`);
        }
      })
    );
  },
};
