import { NATIVE_BRIDGE_PROTOCOL, type NativeHealth } from "../shared/native.ts";
import { bridgeRequest } from "./native.ts";
import {
  youtubeVideoUrl,
  type YoutubeMessage,
  type YoutubeSelection,
} from "../shared/youtube.ts";

function videoUrl(value: string): string {
  const url = youtubeVideoUrl(value);
  if (!url) throw new Error("Откройте конкретное видео на YouTube.");
  return url;
}

function selectionValue(value: YoutubeSelection): YoutubeSelection {
  if (
    !value ||
    !["mp4", "mp3"].includes(value.format) ||
    !Number.isFinite(value.start) ||
    value.start < 0 ||
    (value.end !== null &&
      (!Number.isFinite(value.end) || value.end <= value.start))
  ) {
    throw new Error(
      "Проверьте формат и границы отрезка: конец должен быть позже начала.",
    );
  }
  return { format: value.format, start: value.start, end: value.end };
}

async function youtubeCookies() {
  const cookies = await chrome.cookies.getAll({ domain: "youtube.com" });
  return cookies.map(
    ({ domain, path, name, value, secure, expirationDate }) => ({
      domain,
      path,
      name,
      value,
      secure,
      expires: expirationDate ?? null,
    }),
  );
}

export async function readYoutubePlayer(tabId: number, expectedUrl: string, documentId?: string) {
  const url = videoUrl(expectedUrl);
  const tab = await chrome.tabs.get(tabId);
  if (youtubeVideoUrl(tab.url) !== url) throw new Error("capture_expired");
  const origin = new URL(tab.url!).origin;
  const [capture] = await chrome.scripting.executeScript({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) },
    args: [origin],
    func: (expectedOrigin: string) => {
      if (location.origin !== expectedOrigin) return null;
      const videos = [...document.querySelectorAll("video")];
      // Music can hide its sole video; Shorts can retain a hidden watch-page player.
      let video = videos.length === 1 ? videos[0] : undefined;
      let largestArea = 0;
      for (const candidate of videos) {
        const rect = candidate.getBoundingClientRect();
        const area =
          Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))
          * Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        if (area > largestArea) {
          largestArea = area;
          video = candidate;
        }
      }
      return {
        url: location.href,
        time: video?.currentTime ?? null,
        media: [...document.querySelectorAll<HTMLMediaElement>("video,audio")]
          .map((element) => element.currentSrc || element.src).filter(Boolean).sort(),
      };
    },
  });
  const position = capture?.result;
  if (!capture?.documentId || !position || youtubeVideoUrl(position.url) !== url) {
    throw new Error("capture_expired");
  }
  if (position.time === null || !Number.isFinite(position.time) || position.time < 0) {
    throw new Error("Запустите видео или трек на странице, затем откройте его в qplay.");
  }
  return {
    identity: { url: position.url, documentId: capture.documentId, media: position.media },
    start: position.time,
  };
}

export async function captureYoutubePlayback(tabId: number, expectedUrl: string) {
  const { identity, start } = await readYoutubePlayer(tabId, expectedUrl);
  return {
    identity,
    payload: { url: videoUrl(expectedUrl), start, cookies: await youtubeCookies() },
  };
}

export async function handleYoutubeMessage(
  message: YoutubeMessage,
): Promise<unknown> {
  switch (message.type) {
    case "youtube:health": {
      const health = (await bridgeRequest("/health")) as NativeHealth;
      if (health.protocol !== NATIVE_BRIDGE_PROTOCOL) {
        throw new Error(
          "Обновите qcatch: версия помощника несовместима с расширением.",
        );
      }
      return health;
    }
    case "youtube:info":
      return bridgeRequest("/info", {
        url: videoUrl(message.url),
        retry: message.retry === true,
        cookies: await youtubeCookies(),
      });
    case "youtube:retry-tools":
      return bridgeRequest("/tools/retry", {});
    case "youtube:jobs":
      return bridgeRequest("/jobs");
    case "youtube:download":
      return bridgeRequest("/jobs", {
        url: videoUrl(message.url),
        ...selectionValue(message.selection),
        cookies: await youtubeCookies(),
      });
    case "youtube:cancel":
    case "youtube:reveal": {
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(message.jobId))
        throw new Error("Неизвестная загрузка.");
      return bridgeRequest(
        `/jobs/${message.jobId}/${message.type === "youtube:cancel" ? "cancel" : "reveal"}`,
        {},
      );
    }
    case "youtube:selection:get": {
      const key = `youtube:${message.tabId}`;
      const stored = (await chrome.storage.session.get(key))[key] as
        { url: string; selection: YoutubeSelection } | undefined;
      return stored?.url === videoUrl(message.url)
        ? stored.selection
        : undefined;
    }
    case "youtube:selection:set": {
      const url = videoUrl(message.url);
      const selection = selectionValue(message.selection);
      await chrome.storage.session.set({
        [`youtube:${message.tabId}`]: { url, selection },
      });
      return { saved: true };
    }
  }
}
