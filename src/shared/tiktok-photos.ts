import { platformReference } from "./platforms.ts";

export type TikTokPhotos = {
  postId: string;
  title: string;
  urls: string[];
};

export function validateTikTokPhotos(
  value: unknown,
  pageUrl: string,
): TikTokPhotos | undefined {
  const reference = platformReference(pageUrl);
  if (
    reference?.service !== "tiktok"
    || !new URL(reference.url).pathname.includes("/photo/")
  ) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const capture = value as Partial<TikTokPhotos>;
  if (
    capture.postId !== reference.id
    || typeof capture.title !== "string"
    || !Array.isArray(capture.urls)
    || !capture.urls.length
    || capture.urls.length > 32
  ) return undefined;

  for (const value of capture.urls) {
    if (typeof value !== "string" || value.length > 16_384) return undefined;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:"
        || url.username || url.password
        || !/(?:^|\.)tiktokcdn(?:-eu|-us)?\.com$/.test(url.hostname)
      ) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    postId: capture.postId,
    title: capture.title.slice(0, 2000),
    urls: capture.urls,
  };
}

export function extractTikTokPhotos(value: string, pageUrl: string): TikTokPhotos | undefined {
  try {
    const data = JSON.parse(value);
    const item = data.itemInfo?.itemStruct
      ?? data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    return validateTikTokPhotos({
      postId: item?.id,
      title: item?.desc || `TikTok ${item?.id}`,
      urls: item?.imagePost?.images?.map(
        (image: { imageURL?: { urlList?: string[] } }) => image.imageURL?.urlList?.[0],
      ),
    }, pageUrl);
  } catch {
    return undefined;
  }
}
