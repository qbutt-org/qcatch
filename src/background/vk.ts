import { buildFilename } from "../shared/filename.ts";
import type { MediaDownload } from "../shared/types.ts";
import { parseVkVideoUrl } from "../shared/vk.ts";
import type { VkVideoReference } from "../shared/vk.ts";

type VkVideoResult = { error: string } | { title: string; url: string };

// Runs in the page's MAIN world so VK receives its own session, origin and referrer.
async function readVkVideo(reference: VkVideoReference, pageUrl: string): Promise<VkVideoResult> {
  if (location.href !== pageUrl) return { error: "Видео изменилось. Нажмите иконку ещё раз." };
  try {
    const body = new URLSearchParams({ act: "show", al: "1", video: reference.id });
    if (reference.list) body.set("list", reference.list);
    const response = await fetch("/al_video.php?act=show", {
      body,
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      method: "POST",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return { error: `VK вернул HTTP ${response.status}. Обновите страницу и повторите загрузку.` };
    }
    const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
    const data = JSON.parse(new TextDecoder(charset).decode(await response.arrayBuffer()));
    const params = data.payload?.[1]?.[4]?.player?.params?.[0];
    if (!params || `${params.oid}_${params.vid}` !== reference.id) {
      return { error: "VK не выдал данные этого видео. Откройте его в плеере и повторите загрузку." };
    }
    if (params.drm || params.widevine || params.license_url) {
      return { error: "Это видео защищено DRM и не поддерживается." };
    }
    if (params.live === 2) {
      return { error: "Загрузка незавершённых прямых эфиров VK пока не поддерживается." };
    }

    const sources: Array<{ height: number; url: string }> = [];
    for (const [key, value] of Object.entries(params)) {
      const quality = key.match(/^url(\d+)$/);
      if (!quality || typeof value !== "string" || !value) continue;
      sources.push({ height: Number(quality[1]), url: value });
    }
    const source = sources.sort((left, right) => right.height - left.height)[0];
    if (!source) {
      return { error: "VK не выдал MP4 для этого видео. Проверьте доступ к нему в плеере и обновите страницу." };
    }
    const url = new URL(source.url);
    if (url.protocol !== "https:") {
      return { error: "VK выдал некорректную ссылку максимального качества. Обновите страницу и повторите загрузку." };
    }

    const title = document.createElement("textarea");
    title.innerHTML = typeof params.md_title === "string" ? params.md_title : "";
    if (location.href !== pageUrl) return { error: "Видео изменилось. Нажмите иконку ещё раз." };
    return { title: title.value, url: url.href };
  } catch {
    return { error: "Не удалось получить видео VK. Оставьте исходную вкладку открытой, обновите её и повторите загрузку." };
  }
}

export async function fetchVkDownload(tab: chrome.tabs.Tab): Promise<MediaDownload> {
  const reference = parseVkVideoUrl(tab.url);
  if (!reference || tab.id === undefined || !tab.url) throw new Error("Откройте видео VK и повторите загрузку.");
  const [script] = await chrome.scripting.executeScript({
    args: [reference, tab.url],
    func: readVkVideo,
    target: { tabId: tab.id },
    world: "MAIN",
  });
  const result = script?.result;
  if (!result) throw new Error("Плеер VK не ответил. Обновите страницу и повторите загрузку.");
  if ("error" in result) throw new Error(result.error);
  return {
    filename: buildFilename(result.title || `vk_${reference.id}`, "mp4"),
    type: "video",
    url: result.url,
  };
}
