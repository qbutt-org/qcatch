/*
 * Twitter/X extraction logic is adapted from cobalt:
 * https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/processing/services/twitter.js
 *
 * cobalt is Copyright (C) 2024 imput and licensed under AGPL-3.0.
 * This browser-oriented port is distributed under the same license.
 */

import { parseTwitterPostUrl } from "../shared/twitter-page.ts";
import { twitterMediaFromTweet } from "../shared/twitter-media.ts";

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";

export class TwitterMediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TwitterMediaError";
    this.code = code;
  }
}

export function parseTweetUrl(value) {
  const reference = parseTwitterPostUrl(value);
  if (!reference) {
    throw new TwitterMediaError(
      "unsupported-url",
      "Откройте конкретный пост Twitter/X и нажмите иконку ещё раз.",
    );
  }
  return reference;
}

export async function fetchTwitterMedia(
  rawUrl,
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  const { id, index } = parseTweetUrl(rawUrl);
  const url = new URL(SYNDICATION_URL);
  url.searchParams.set("id", id);
  url.searchParams.set("token", syndicationToken(id));

  let tweet;
  try {
    const response = await fetchImplementation(url, { credentials: "omit" });
    if (response.ok) {
      tweet = await response.json();
    }
  } catch {
    throw new TwitterMediaError(
      "fetch-failed",
      "Не удалось получить данные поста от Twitter/X.",
    );
  }

  const media = twitterMediaFromTweet(tweet);
  if (media.length === 0) {
    throw new TwitterMediaError(
      "no-media",
      "В посте нет доступных медиа или он недоступен без авторизации.",
    );
  }

  return twitterMediaToDownloads(rawUrl, media);
}

export function twitterMediaToDownloads(rawUrl, media) {
  const { id, index } = parseTweetUrl(rawUrl);
  const selectedMedia = index === undefined ? media : [media[index]];
  if (selectedMedia.some((item) => item === undefined)) {
    throw new TwitterMediaError(
      "media-index",
      "В ссылке указан номер медиа, которого нет в посте.",
    );
  }

  const downloads = selectedMedia
    .map((item, mediaIndex) => toDownload(item, id, index === undefined && media.length > 1, mediaIndex))
    .filter(Boolean);

  if (downloads.length === 0) {
    throw new TwitterMediaError(
      "no-downloadable-media",
      "В посте не найден MP4-вариант видео.",
    );
  }

  return downloads;
}

function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

function toDownload(media, tweetId, includeIndex, mediaIndex) {
  const suffix = includeIndex ? `_${mediaIndex + 1}` : "";

  if (media?.type === "photo" && media.mediaUrl) {
    const url = new URL(media.mediaUrl);
    url.searchParams.set("name", "4096x4096");
    const extension = fileExtension(url, "jpg");

    return {
      type: "photo",
      url: url.toString(),
      filename: `twitter_${tweetId}${suffix}.${extension}`,
    };
  }

  const variants = media?.variants;
  if (!Array.isArray(variants)) {
    return undefined;
  }

  const bestVariant = variants
    .reduce(
      (best, variant) =>
        Number(variant.bitrate ?? 0) > Number(best?.bitrate ?? -1)
          ? variant
          : best,
      undefined,
    );

  if (!bestVariant) {
    return undefined;
  }

  const url = new URL(bestVariant.url);
  url.searchParams.delete("tag");
  const isGif = media.type === "animated_gif";

  return {
    type: isGif ? "gif" : "video",
    ...(isGif ? { convertToGif: true } : {}),
    url: url.toString(),
    filename: `twitter_${tweetId}${suffix}.${isGif ? "gif" : "mp4"}`,
  };
}

function fileExtension(url, fallback) {
  const match = url.pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() ?? fallback;
}
