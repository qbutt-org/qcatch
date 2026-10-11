import type { CapturedHeader, MediaKind, Provider } from "./types.ts";

const MANIFEST_BODY = /(?:#EXTM3U|<MPD\b)/i;
const HLS_URL = /(?:\.m3u8)(?:$|[?#])/i;
const DASH_URL = /(?:\.mpd)(?:$|[?#])/i;
const SUBTITLE_URL = /(?:\.(?:ass|srt|vtt))(?:$|[?#])/i;
const SEGMENT_URL = /(?:\.(?:m4s|m4v|m4a|ts))(?:$|[?#])/i;
const VIDEO_URL = /(?:\.(?:mp4|mkv|webm|mov))(?:$|[?#])/i;
const AUDIO_URL = /(?:\.(?:aac|ac3|eac3|flac|m4a|mp3|ogg|opus))(?:$|[?#])/i;

export function classifyMedia(
  url: string,
  contentType = "",
  body = "",
): MediaKind {
  if (/^#EXTM3U/m.test(body) || HLS_URL.test(url) || /mpegurl/i.test(contentType)) {
    return "hls";
  }

  if (/<MPD\b/i.test(body) || DASH_URL.test(url) || /dash\+xml/i.test(contentType)) {
    return "dash";
  }

  if (SUBTITLE_URL.test(url) || /(?:text\/vtt|application\/(?:x-subrip|ttml\+xml))/i.test(contentType)) {
    return "subtitle";
  }

  if (SEGMENT_URL.test(url) || /(?:mp2t|iso\.segment)/i.test(contentType)) {
    return "segment";
  }

  if (VIDEO_URL.test(url) || /^video\//i.test(contentType)) {
    return "video";
  }

  if (AUDIO_URL.test(url) || /^audio\//i.test(contentType)) {
    return "audio";
  }

  return MANIFEST_BODY.test(body) ? "hls" : "unknown";
}

export function detectProvider(url: string, initiator = ""): Provider {
  const haystack = `${url} ${initiator}`.toLowerCase();
  if (/alloha|yani\.tv|vkvideo\.cloud/.test(haystack)) return "alloha";
  if (/kodik|kodikplayer|solodcdn|mimin\.cloud/.test(haystack)) return "kodik";
  if (/cdnvideohub|plapi\.|cvh/.test(haystack)) return "cdnvideohub";
  return "unknown";
}

export function isInterestingMedia(kind: MediaKind): boolean {
  return kind !== "unknown";
}

export function normalizedHeaders(
  headers: readonly { name: string; value?: string | undefined }[] = [],
): CapturedHeader[] {
  const allowed = /^(?:accept|accepts-controls|authorization|authorizations|origin|range|referer|x-[\w-]+)$/i;
  const seen = new Set<string>();
  const result: CapturedHeader[] = [];

  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value?.trim();
    const key = name.toLowerCase();
    if (!value || !allowed.test(name) || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, value });
  }

  return result;
}

export function resourceKey(url: string): string {
  const stableUrl = url.replace(/([?&](?:_t|cache|rnd|timestamp)=)[^&]*/gi, "$1");
  let hash = 2166136261;
  for (let index = 0; index < stableUrl.length; index += 1) {
    hash ^= stableUrl.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function guessContentType(headers: readonly { name: string; value?: string | undefined }[]): string {
  return headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
}
