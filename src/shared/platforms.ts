export type Platform =
  | "tiktok"
  | "reddit"
  | "twitch"
  | "instagram"
  | "pinterest"
  | "soundcloud"
  | "yandexmusic"
  | "vkmusic";

export type PlatformReference = {
  service: Platform;
  url: string;
  id: string;
  kind: "post" | "clip" | "live" | "track";
};

export const PLATFORM_NAMES: Record<Platform, string> = {
  tiktok: "TikTok",
  reddit: "Reddit",
  twitch: "Twitch",
  instagram: "Instagram",
  pinterest: "Pinterest",
  soundcloud: "SoundCloud",
  yandexmusic: "Yandex Music",
  vkmusic: "VK Music",
};

export function platformReference(
  value: string | undefined,
): PlatformReference | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return undefined;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|old|new)\./, "");
  const path = url.pathname;
  let service: Platform;
  let kind: PlatformReference["kind"] = "post";
  let id: string | undefined;

  if (host === "tiktok.com") {
    service = "tiktok";
    id =
      path.match(/^\/@[^/]+\/(?:video|photo)\/(\d+)\/?$/)?.[1] ??
      path.match(/^\/(?:share\/video|embed|v)\/(\d+)(?:\.html)?\/?$/)?.[1] ??
      path.match(/^\/t\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  } else if (["vm.tiktok.com", "vt.tiktok.com"].includes(host)) {
    service = "tiktok";
    id = path.match(/^\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  } else if (["reddit.com", "redditmedia.com"].includes(host)) {
    service = "reddit";
    id =
      path.match(
        /^\/(?:r\/[^/]+\/|user\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i,
      )?.[1] ?? path.match(/^\/r\/[^/]+\/s\/([A-Za-z0-9]+)\/?$/)?.[1];
  } else if (host === "v.redd.it") {
    service = "reddit";
    id = path.match(/^\/([a-z0-9]+)\/?$/i)?.[1];
  } else if (
    [
      "twitch.tv",
      "go.twitch.tv",
      "clips.twitch.tv",
      "player.twitch.tv",
    ].includes(host)
  ) {
    service = "twitch";
    id =
      path.match(/^\/(?:[^/]+\/)?clip\/([A-Za-z0-9_-]+)\/?$/)?.[1] ??
      (host === "clips.twitch.tv"
        ? path === "/embed"
          ? (url.searchParams.get("clip") ?? undefined)
          : path.match(/^\/([A-Za-z0-9_-]+)\/?$/)?.[1]
        : undefined);
    kind = id ? "clip" : "live";
    id ??=
      host === "player.twitch.tv"
        ? (url.searchParams.get("channel") ?? undefined)
        : path.match(/^\/([A-Za-z0-9_]+)\/?$/)?.[1];
    if (
      id &&
      kind === "live" &&
      [
        "directory",
        "downloads",
        "settings",
        "videos",
        "subscriptions",
      ].includes(id.toLowerCase())
    )
      id = undefined;
  } else if (host === "instagram.com") {
    service = "instagram";
    id = path.match(
      /^\/(?:[^/]+\/)?(?:p|tv|reel|reels)\/([A-Za-z0-9_-]+)\/?$/,
    )?.[1];
  } else if (
    /^(?:[a-z]{2}\.)?pinterest\.(?:com|co\.uk|de|fr|es|it|ca|com\.au|jp|ru)$/.test(host)
  ) {
    service = "pinterest";
    id = path.match(/^\/pin\/(?:[^/]+--)?(\d+)\/?$/)?.[1];
  } else if (host === "pin.it") {
    service = "pinterest";
    id = path.match(/^\/([A-Za-z0-9]+)\/?$/)?.[1];
  } else if (host === "soundcloud.com") {
    service = "soundcloud";
    kind = "track";
    const match = path.match(/^\/([^/]+)\/([^/]+)(?:\/(s-[A-Za-z0-9]+))?\/?$/);
    if (
      match &&
      ![
        "sets",
        "tracks",
        "likes",
        "reposts",
        "albums",
        "popular-tracks",
      ].includes(match[2]!)
    )
      id = `${match[1]}/${match[2]}`;
  } else if (/^music\.yandex\.(?:ru|kz|ua|by|com)$/.test(host)) {
    service = "yandexmusic";
    kind = "track";
    id =
      path.match(/^\/album\/\d+\/track\/(\d+)\/?$/)?.[1] ??
      path.match(/^\/track\/(\d+)\/?$/)?.[1];
  } else if (
    ["vk.com", "vk.ru", "music.vk.com", "music.vk.ru"].includes(host)
  ) {
    service = "vkmusic";
    kind = "track";
    id =
      path.match(/^\/audio(-?\d+_\d+)\/?$/)?.[1] ??
      url.searchParams.get("z")?.match(/^audio(-?\d+_\d+)(?:\/|$)/)?.[1];
  } else return undefined;

  if (!id) return undefined;
  if (service === "twitch") {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    url = new URL(
      kind === "clip"
        ? `https://clips.twitch.tv/${id}`
        : `https://www.twitch.tv/${id.toLowerCase()}`,
    );
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|si$|feature$|share_|ref$)/i.test(key))
      url.searchParams.delete(key);
  }
  return { service, kind, id, url: url.href };
}
