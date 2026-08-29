import { AssetRecordType, TLAsset, TLBookmarkAsset, getHashForString } from "tldraw";

export async function getBookmarkAsset({ url }: { url: string }): Promise<TLAsset> {
  return {
    id: AssetRecordType.createId(getHashForString(url)),
    typeName: "asset",
    type: "bookmark",
    meta: {},
    props: {
      src: url,
      description: "",
      image: "",
      favicon: "",
      title: "",
    },
  } satisfies TLBookmarkAsset;
}
