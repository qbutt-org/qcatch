import { buildFilename } from "../shared/filename.ts";
import type { PlatformReference } from "../shared/platforms.ts";
import { readInstagramAssets } from "./instagram.ts";
import { readFileDashAssets, type FileDashMedia } from "./page-dash.ts";
import type { Container } from "../shared/types.ts";
import { readTabState } from "./state.ts";
import { validateTikTokPhotos } from "../shared/tiktok-photos.ts";

export type PlatformAsset = {
  url: string;
  kind: "video" | "audio" | "hls" | "photo" | "gif";
  filename: string;
  container: Container;
  audioOnly?: boolean;
  duration?: number;
  audioTracks?: FileDashMedia["audioTracks"];
};

export type PageAssets = {
  title: string;
  assets: Array<Omit<PlatformAsset, "filename" | "container"> | {
    kind: "file-dash";
    manifest: string;
    manifestUrl: string;
    requireAudio: boolean;
    duration?: number;
  }>;
};

// This function is serialized into the source page. Its requests use that page's session.
async function readPageAssets(
  reference: PlatformReference,
  pageUrl: string,
): Promise<PageAssets | { native: true } | { error: string }> {
  if (location.href !== pageUrl)
    return { error: "The page changed. Open the media again and retry." };
  type Item = Record<string, any>;
  const https = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  };
  const best = (values: Item[] | undefined): string | undefined =>
    values
      ?.filter((item) => https(item.url))
      .sort(
        (left, right) =>
          Number(right.width ?? 0) * Number(right.height ?? 0) -
            Number(left.width ?? 0) * Number(left.height ?? 0) ||
          Number(right.bitrate ?? 0) - Number(left.bitrate ?? 0),
      )[0]?.url;
  const json = async (
    url: string,
    headers: Record<string, string> = {},
  ): Promise<Item> => {
    const response = await fetch(url, {
      credentials: "include",
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Sign in to the source site, open the media and retry."
          : `The source returned HTTP ${response.status}. Reload the page and retry.`,
      );
    return response.json();
  };
  try {
    let result: PageAssets;
    if (reference.service === "reddit") {
      const response = await json(
        `https://www.reddit.com/comments/${reference.id}.json?raw_json=1`,
      );
      const post = response[0]?.data?.children?.find(
        (child: Item) => child.kind === "t3" && child.data?.id === reference.id,
      )?.data;
      if (!post || post.name !== `t3_${reference.id}`)
        throw new Error(
          "The source returned different media. Reload the post and retry.",
        );
      const url = https(post.url_overridden_by_dest ?? post.url);
      if (
        !url ||
        new URL(url).hostname !== "i.redd.it" ||
        !/\.gif$/i.test(new URL(url).pathname)
      ) {
        const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
        if (!video) return { native: true };
        const playlist = https(video.dash_url);
        if (!playlist) throw new Error("The source did not return this media. Open it in the site's player and retry.");
        const stream = await fetch(playlist, { signal: AbortSignal.timeout(20_000) });
        if (!stream.ok) throw new Error(`The source returned HTTP ${stream.status}. Reload the page and retry.`);
        result = {
          title: post.title || `Reddit ${reference.id}`,
          assets: [{
            kind: "file-dash",
            manifest: await stream.text(),
            manifestUrl: playlist,
            requireAudio: video.is_gif === false,
            ...(Number(video.duration) > 0 ? { duration: Number(video.duration) } : {}),
          }],
        };
      } else {
        result = {
          title: post.title || `Reddit ${reference.id}`,
          assets: [{ url, kind: "gif" }],
        };
      }
    } else if (reference.service === "pinterest") {
      if (!/^\d+$/.test(reference.id))
        throw new Error("Open the full Pinterest pin link and retry.");
      const data = JSON.stringify({
        options: { field_set_key: "unauth_react_main_pin", id: reference.id },
      });
      const response = await json(
        `/resource/PinResource/get/?data=${encodeURIComponent(data)}`,
        { "X-Pinterest-PWS-Handler": "www/[username].js" },
      );
      const pin = response.resource_response?.data;
      if (!pin || String(pin.id) !== reference.id)
        throw new Error(
          "The source returned different media. Reload the post and retry.",
        );
      const maps: Item[] = [
        pin.videos?.video_list,
        ...(pin.story_pin_data?.pages ?? []).flatMap((page: Item) =>
          (page.blocks ?? []).map((block: Item) => block.video?.video_list),
        ),
      ].filter(Boolean);
      const assets: PageAssets["assets"] = [];
      for (const map of maps) {
        const url = best(Object.values(map));
        if (url)
          assets.push({
            url,
            kind: /\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "video",
          });
      }
      if (!assets.length) {
        if (
          pin.videos ||
          pin.is_video === true ||
          pin.is_videopin === true ||
          pin.story_pin_data?.pages?.length ||
          maps.length
        )
          throw new Error(
            "The source did not return this media. Open it in the site's player and retry.",
          );
        const url = https(pin.images?.orig?.url);
        if (!url)
          throw new Error(
            "This pin has no downloadable media. Open the original source instead.",
          );
        const kind = /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "photo";
        if (
          kind === "photo" &&
          pin.embed?.src &&
          pin.domain !== "uploaded by user"
        )
          throw new Error(
            "This pin links to another site's video. Open its original source and download it there.",
          );
        assets.push({ url, kind });
      }
      result = {
        title: pin.title || pin.grid_title || `Pinterest ${reference.id}`,
        assets,
      };
    } else if (reference.service === "vkmusic") {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-audio]")];
      const tracks: Item[] = [];
      for (const row of rows) {
        let audio: Item;
        try {
          audio = JSON.parse(row.dataset.audio ?? "");
        } catch {
          continue;
        }
        if (Array.isArray(audio)) continue;
        if (`${audio.owner_id}_${audio.id}` === reference.id)
          tracks.push(audio);
      }
      const urls = new Map(
        tracks
          .filter((track) => https(track.url))
          .map((track) => [track.url, track]),
      );
      if (urls.size !== 1)
        throw new Error(
          "Open and play this exact VK Music track, then retry. Its full audio link is not available on this page.",
        );
      const [url, track] = [...urls][0]!;
      result = {
        title: `${track.artist || ""} - ${track.title || reference.id}`.replace(
          /^ - /,
          "",
        ),
        assets: [
          {
            url,
            kind: /\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "audio",
            audioOnly: true,
            ...(Number(track.duration) > 0
              ? { duration: Number(track.duration) }
              : {}),
          },
        ],
      };
    } else
      throw new Error("This page does not use the browser asset resolver.");
    if (location.href !== pageUrl)
      throw new Error("The page changed. Open the media again and retry.");
    if (!result.assets.length || result.assets.length > 32)
      throw new Error(
        "The post has no downloadable media or too many items. Open one post and retry.",
      );
    return result;
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not read this media. Reload the source page and retry.",
    };
  }
}

export async function platformAssets(
  tab: chrome.tabs.Tab,
  reference: PlatformReference,
): Promise<PlatformAsset[] | undefined> {
  if (tab.id === undefined || !tab.url)
    throw new Error("Open the source page and retry.");
  let result: PageAssets | { native: true } | { error: string } | undefined;
  if (reference.service === "tiktok") {
    const capture = validateTikTokPhotos((await readTabState(tab.id)).tiktokPhotos, tab.url);
    if (!capture) throw new Error("Reload this TikTok photo post and retry.");
    result = { title: capture.title, assets: capture.urls.map(url => ({ url, kind: "photo" })) };
  } else {
    const [script] = await chrome.scripting.executeScript({
      func: reference.service === "instagram" ? readInstagramAssets : readPageAssets,
      args: [reference, tab.url],
      target: { tabId: tab.id },
      world: "MAIN",
    });
    result = script?.result;
  }
  if (!result)
    throw new Error("The source page did not respond. Reload it and retry.");
  if ("error" in result) throw new Error(result.error);
  if ("native" in result) return undefined;
  const assets: Array<Omit<PlatformAsset, "filename" | "container">> = [];
  for (const asset of result.assets) {
    if (asset.kind !== "file-dash") {
      assets.push(asset);
      continue;
    }
    const [resolved] = await chrome.scripting.executeScript({
      func: readFileDashAssets,
      args: [asset.manifest, asset.manifestUrl, tab.url, asset.requireAudio],
      target: { tabId: tab.id },
      world: "MAIN",
    });
    const media = resolved?.result;
    if (!media) throw new Error("The source page did not respond. Reload it and retry.");
    if ("error" in media) throw new Error(media.error);
    assets.push({ ...media, ...(asset.duration ? { duration: asset.duration } : {}) });
  }
  const seen = new Set<string>();
  return assets
    .filter((asset) => !seen.has(asset.url) && Boolean(seen.add(asset.url)))
    .map((media, index) => {
      const container: Container = (media.audioTracks?.length ?? 0) > 1 ? "mkv" : "mp4";
      const extension =
        media.kind === "gif"
          ? "gif"
          : media.kind === "photo"
            ? (new URL(media.url).pathname.match(/\.(png|webp|jpe?g)$/i)?.[1] ??
              "jpg")
            : media.kind === "audio"
              ? (new URL(media.url).pathname.match(
                  /\.(mp3|m4a|ogg|opus|flac)$/i,
                )?.[1] ?? "m4a")
              : container;
      return {
        ...media,
        container,
        filename: buildFilename(
          `${result.title}${result.assets.length > 1 ? ` (${index + 1})` : ""}`,
          extension,
        ),
      };
    });
}
