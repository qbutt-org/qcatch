import type { PageAssets } from "./platform-assets.ts";
import type { PlatformReference } from "../shared/platforms.ts";

// Serialized into the selected page, so all runtime dependencies stay inside this function.
export async function readInstagramAssets(
  reference: PlatformReference,
  pageUrl: string,
): Promise<PageAssets | { error: string }> {
  const unavailable = "The source did not return this media. Open it in the site's player and retry.";
  type Media = Record<string, any>;
  const https = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const best = (values: Media[] | undefined): Media | undefined =>
    values
      ?.filter(item => https(item.url))
      .sort((left, right) =>
        Number(right.width ?? 0) * Number(right.height ?? 0)
        - Number(left.width ?? 0) * Number(left.height ?? 0)
        || Number(right.bitrate ?? 0) - Number(left.bitrate ?? 0),
      )[0];

  try {
    if (location.href !== pageUrl) throw new Error("The page changed. Open the media again and retry.");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let pk = 0n;
    for (const char of reference.id) pk = pk * 64n + BigInt(alphabet.indexOf(char));

    // Relay includes public media even when the account API requires login.
    // Both identifiers exclude route scaffolding, recommendations and stale posts.
    let item: Media | undefined;
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent;
      if (!text || text.length > 2 * 1024 * 1024) continue;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const pending: unknown[] = [data];
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) {
          for (const child of value) pending.push(child);
          continue;
        }
        const candidate = value as Media;
        if (
          candidate.code === reference.id
          && String(candidate.pk) === String(pk)
          && [1, 2, 8].includes(candidate.media_type)
        ) {
          item = candidate;
          break;
        }
        for (const key of ["require", "__bbox", "result", "data", "xig_polaris_media", "if_not_gated_logged_out"]) {
          if (candidate[key]) pending.push(candidate[key]);
        }
      }
      if (item) break;
    }
    if (!item) {
      const response = await fetch(`/api/v1/media/${pk}/info/`, {
        credentials: "include",
        headers: {
          "X-IG-App-ID": "936619743392459",
          "X-ASBD-ID": "359341",
          "X-IG-WWW-Claim": "0",
          Accept: "*/*",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (
        response.status === 401 || response.status === 403
        || new URL(response.url).pathname.startsWith("/accounts/login")
      ) {
        throw new Error("Sign in to the source site, open the media and retry.");
      }
      if (!response.ok) throw new Error(`The source returned HTTP ${response.status}. Reload the page and retry.`);
      let data: Media;
      try {
        data = await response.json();
      } catch {
        throw new Error(unavailable);
      }
      item = data.items?.[0];
    }
    const returnedId = typeof item?.pk === "string"
      ? item.pk
      : typeof item?.id === "string" ? item.id.split("_")[0] : item?.pk;
    if (!item || String(returnedId) !== String(pk)) {
      throw new Error("The source returned different media. Reload the post and retry.");
    }

    const assets: PageAssets["assets"] = (item.carousel_media ?? [item]).map((entry: Media) => {
      if (entry.video_dash_manifest) {
        return {
          kind: "file-dash" as const,
          manifest: entry.video_dash_manifest,
          manifestUrl: reference.url,
          requireAudio: entry.has_audio === true,
          ...(Number(entry.video_duration) > 0 ? { duration: Number(entry.video_duration) } : {}),
        };
      }
      const video = best(entry.video_versions);
      if (!video && (entry.media_type === 2 || entry.video_duration)) throw new Error(unavailable);
      const url = video?.url ?? best(entry.image_versions2?.candidates)?.url;
      if (!url) throw new Error(unavailable);
      const duration = entry.video_duration;
      return {
        url,
        kind: video ? "video" as const : "photo" as const,
        ...(video && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      };
    });
    if (location.href !== pageUrl) throw new Error("The page changed. Open the media again and retry.");
    if (!assets.length || assets.length > 32) {
      throw new Error("The post has no downloadable media or too many items. Open one post and retry.");
    }
    return { title: item.caption?.text?.slice(0, 180) || `Instagram ${reference.id}`, assets };
  } catch (error) {
    return { error: error instanceof Error ? error.message : unavailable };
  }
}
