import { buildFilename } from "../shared/filename.ts";
import { parseRutubeVideoUrl } from "../shared/rutube.ts";
import type { DownloadJob } from "../shared/types.ts";

export async function prepareRutubeJob(tab: chrome.tabs.Tab): Promise<DownloadJob> {
  const videoId = parseRutubeVideoUrl(tab.url);
  if (!videoId || tab.id === undefined || !tab.url) throw new Error("Откройте видео Rutube и повторите загрузку.");
  const response = await fetch(`https://rutube.ru/api/play/options/${videoId}/?format=json`, {
    credentials: "include",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error("Не удалось получить видео Rutube. Проверьте подключение, обновите страницу и повторите загрузку.");
  });
  if (!response.ok) {
    throw new Error(`Rutube вернул HTTP ${response.status}. Проверьте доступ к видео в плеере и обновите страницу.`);
  }
  const options = await response.json() as {
    drm_token?: string;
    live_streams?: Record<string, unknown>;
    title?: string;
    video_balancer?: { m3u8?: string };
  };
  if (options.drm_token) throw new Error("Это видео Rutube защищено DRM и не поддерживается.");
  if (options.live_streams && Object.keys(options.live_streams).length > 0) {
    throw new Error("Загрузка незавершённых прямых эфиров Rutube пока не поддерживается.");
  }
  const source = options.video_balancer?.m3u8;
  if (!source) throw new Error("Rutube не выдал HLS этого видео. Запустите его в плеере и повторите загрузку.");
  const url = new URL(source);
  if (url.protocol !== "https:") throw new Error("Rutube выдал некорректную ссылку. Обновите страницу и повторите загрузку.");
  const title = options.title || `rutube_${videoId}`;
  return {
    container: "mp4",
    createdAt: Date.now(),
    filename: buildFilename(title, "mp4"),
    id: crypto.randomUUID(),
    inputs: [{ headers: [], kind: "hls", role: "media", url: url.href }],
    pageUrl: tab.url,
    player: "Rutube",
    subtitles: [],
    tabId: tab.id,
    title,
  };
}
