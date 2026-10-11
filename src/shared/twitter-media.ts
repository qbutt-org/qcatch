import { parseTwitterPostUrl } from "./twitter-page.ts";

export type TwitterMediaVariant = {
  bitrate?: number;
  url: string;
};

export type TwitterMedia =
  | { mediaUrl: string; type: "photo" }
  | { type: "animated_gif" | "video"; variants: TwitterMediaVariant[] };

export type TwitterCapture = {
  media: TwitterMedia[];
  tweetId: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function twitterMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "twimg.com" || url.hostname.endsWith(".twimg.com"))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeVariant(value: unknown): TwitterMediaVariant | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const contentType = candidate.content_type ?? candidate.contentType;
  if (contentType !== undefined && contentType !== "video/mp4") return undefined;
  const url = twitterMediaUrl(candidate.url);
  if (!url) return undefined;
  const bitrate = Number(candidate.bitrate);
  return {
    url,
    ...(Number.isFinite(bitrate) && bitrate >= 0 ? { bitrate } : {}),
  };
}

function normalizeMedia(value: unknown): TwitterMedia | undefined {
  const candidate = record(value);
  if (
    !candidate
    || !["animated_gif", "photo", "video"].includes(String(candidate.type))
  ) return undefined;
  const type = candidate.type as TwitterMedia["type"];
  const mediaUrl = twitterMediaUrl(candidate.media_url_https ?? candidate.media_url ?? candidate.mediaUrl);
  const videoInfo = record(candidate.video_info);
  const variantValues = videoInfo?.variants ?? candidate.variants;
  const variants = Array.isArray(variantValues)
    ? variantValues
      .map(normalizeVariant)
      .filter((variant): variant is TwitterMediaVariant => variant !== undefined)
    : [];

  if (type === "photo") return mediaUrl ? { mediaUrl, type } : undefined;
  return variants.length > 0 ? { type, variants } : undefined;
}

function parseCard(cardValue: unknown): unknown[] | undefined {
  const card = record(cardValue);
  const legacy = record(card?.legacy);
  const bindingValues = legacy?.binding_values ?? card?.binding_values;
  let encodedCard: unknown;

  if (Array.isArray(bindingValues)) {
    for (const binding of bindingValues) {
      const value = record(record(binding)?.value)?.string_value;
      if (typeof value === "string") {
        encodedCard = value;
        break;
      }
    }
  } else {
    encodedCard = record(record(bindingValues)?.unified_card)?.string_value;
  }

  if (typeof encodedCard !== "string") return undefined;
  let decoded: UnknownRecord | undefined;
  try {
    decoded = record(JSON.parse(encodedCard));
  } catch {
    return undefined;
  }
  if (!decoded || !["video_website", "image_website"].includes(String(decoded.type))) return undefined;

  const mediaComponent = record(record(decoded.component_objects)?.media_1);
  if (mediaComponent?.type !== "media") return undefined;
  const component = record(mediaComponent.data);
  const mediaEntities = record(decoded.media_entities);
  const media = mediaEntities?.[String(component?.id ?? "")];
  return media ? [media] : undefined;
}

function mediaArray(value: unknown): unknown[] | undefined {
  const candidate = record(value);
  return Array.isArray(candidate?.media) ? candidate.media : undefined;
}

export function twitterMediaFromTweet(value: unknown): TwitterMedia[] {
  const tweet = record(value);
  const legacy = record(tweet?.legacy);
  const media = parseCard(tweet?.card)
    ?? mediaArray(legacy?.extended_entities)
    ?? mediaArray(tweet?.extended_entities)
    ?? (Array.isArray(tweet?.mediaDetails) ? tweet.mediaDetails : undefined)
    ?? [];
  const seen = new Set<string>();
  const result: TwitterMedia[] = [];

  for (const item of media) {
    const normalized = normalizeMedia(item);
    if (!normalized) continue;
    const key = normalized.type === "photo"
      ? `photo:${normalized.mediaUrl}`
      : `${normalized.type}:${normalized.variants[0]?.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function extractTwitterCapture(value: unknown, pageUrl: string): TwitterCapture | undefined {
  const reference = parseTwitterPostUrl(pageUrl);
  const root = jsonValue(value);
  if (!reference || !record(root)) return undefined;

  let best: TwitterMedia[] = [];
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    const object = record(candidate);
    if (!object || visited.has(object)) return;
    visited.add(object);

    const legacy = record(object.legacy);
    if ([object.rest_id, object.id_str, legacy?.id_str].some((id) => String(id ?? "") === reference.id)) {
      const media = twitterMediaFromTweet(object);
      if (media.length > best.length) best = media;
    }

    for (const child of Object.values(object)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(root);

  return best.length > 0
    ? { media: best, tweetId: reference.id }
    : undefined;
}

export function validateTwitterCapture(value: unknown, pageUrl: string): TwitterCapture | undefined {
  const reference = parseTwitterPostUrl(pageUrl);
  const candidate = record(value);
  if (!reference || candidate?.tweetId !== reference.id || !Array.isArray(candidate.media)) return undefined;
  const media = candidate.media
    .map(normalizeMedia)
    .filter((item): item is TwitterMedia => item !== undefined);
  return media.length > 0 ? { media, tweetId: reference.id } : undefined;
}
