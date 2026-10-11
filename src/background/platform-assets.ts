import { buildFilename } from "../shared/filename.ts";
import type { PlatformReference } from "../shared/platforms.ts";

export type PlatformAsset = {
  url: string;
  kind: "video" | "audio" | "hls" | "photo" | "gif";
  filename: string;
  audioOnly?: boolean;
  duration?: number;
};

type PageAssets = {
  title: string;
  assets: Array<Omit<PlatformAsset, "filename">>;
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
        if (location.href !== pageUrl)
          throw new Error("The page changed. Open the media again and retry.");
        return { native: true };
      }
      result = {
        title: post.title || `Reddit ${reference.id}`,
        assets: [{ url, kind: "gif" }],
      };
    } else if (reference.service === "instagram") {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      let pk = 0n;
      for (const char of reference.id)
        pk = pk * 64n + BigInt(alphabet.indexOf(char));
      const response = await json(`/api/v1/media/${pk}/info/`, {
        "X-IG-App-ID": "936619743392459",
        "X-ASBD-ID": "359341",
        "X-IG-WWW-Claim": "0",
        Accept: "*/*",
      });
      const item = response.items?.[0];
      const returnedId =
        typeof item?.id === "string" ? item.id.split("_")[0] : item?.pk;
      if (!item || String(returnedId) !== String(pk))
        throw new Error(
          "The source returned different media. Reload the post and retry.",
        );
      const entries: Item[] = item.carousel_media ?? [item];
      const assets = entries.map((entry) => {
        const video = best(entry.video_versions);
        if (
          !video &&
          (entry.media_type === 2 ||
            entry.video_dash_manifest ||
            entry.video_duration)
        ) {
          throw new Error(
            "The source did not return this media. Open it in the site's player and retry.",
          );
        }
        const url = video ?? best(entry.image_versions2?.candidates);
        if (!url)
          throw new Error(
            "The source did not return this media. Open it in the site's player and retry.",
          );
        return { url, kind: video ? ("video" as const) : ("photo" as const) };
      });
      result = {
        title: item.caption?.text?.slice(0, 180) || `Instagram ${reference.id}`,
        assets,
      };
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
        if (pin.embed?.src && pin.domain !== "uploaded by user") {
          throw new Error(
            "This pin links to another site's video. Open its original source and download it there.",
          );
        }
        const url = https(pin.images?.orig?.url);
        if (!url)
          throw new Error(
            "This pin has no downloadable media. Open the original source instead.",
          );
        assets.push({
          url,
          kind: /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "photo",
        });
      }
      result = {
        title: pin.title || pin.grid_title || `Pinterest ${reference.id}`,
        assets,
      };
    } else if (reference.service === "tiktok") {
      const node = document.getElementById(
        "__UNIVERSAL_DATA_FOR_REHYDRATION__",
      );
      const state = node?.textContent
        ? JSON.parse(node.textContent)
        : undefined;
      const item =
        state?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
      if (!item || String(item.id) !== reference.id)
        throw new Error("Reload this TikTok photo post and retry.");
      const assets = (item.imagePost?.images ?? []).map((image: Item) => {
        const url = (image.imageURL?.urlList ?? []).map(https).find(Boolean);
        if (!url)
          throw new Error(
            "The source did not return this image. Reload the post and retry.",
          );
        return { url, kind: "photo" as const };
      });
      result = { title: item.desc || `TikTok ${reference.id}`, assets };
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
  const [script] = await chrome.scripting.executeScript({
    func: readPageAssets,
    args: [reference, tab.url],
    target: { tabId: tab.id },
    world: "MAIN",
  });
  const result = script?.result;
  if (!result)
    throw new Error("The source page did not respond. Reload it and retry.");
  if ("error" in result) throw new Error(result.error);
  if ("native" in result) return undefined;
  const seen = new Set<string>();
  return result.assets
    .filter((asset) => !seen.has(asset.url) && Boolean(seen.add(asset.url)))
    .map((asset, index) => {
      const extension =
        asset.kind === "gif"
          ? "gif"
          : asset.kind === "photo"
            ? (new URL(asset.url).pathname.match(/\.(png|webp|jpe?g)$/i)?.[1] ??
              "jpg")
            : asset.kind === "audio"
              ? (new URL(asset.url).pathname.match(
                  /\.(mp3|m4a|ogg|opus|flac)$/i,
                )?.[1] ?? "m4a")
              : "mp4";
      return {
        ...asset,
        filename: buildFilename(
          `${result.title}${result.assets.length > 1 ? ` (${index + 1})` : ""}`,
          extension,
        ),
      };
    });
}
