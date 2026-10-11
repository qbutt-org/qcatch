import { parseTwitterPostUrl } from "../shared/twitter-page.ts";
import {
  fetchTwitterMedia,
  TwitterMediaError,
  twitterMediaToDownloads,
} from "../twitter/twitter.js";
import type { MediaDownload, QueueItem } from "../shared/types.ts";
import { oneClickService } from "../shared/one-click.ts";
import { parseRutubeVideoUrl } from "../shared/rutube.ts";
import { prepareRutubeJob } from "./rutube.ts";
import { fetchVkDownload } from "./vk.ts";
import { enqueueDownloads, ensureOffscreenDocument } from "./engine.ts";
import { readQueue } from "./queue.ts";
import { readTabState } from "./state.ts";
import { platformReference } from "../shared/platforms.ts";
import { runPlatform } from "./platforms.ts";
import {
  browserLanguage,
  errorTranslation,
  translate,
  type Language,
  type Message,
} from "../shared/localization.ts";

const activeTabs = new Set<number>();
const gifTasks = new Map<string, number>();
const DOWNLOAD_TITLES = {
  rutube: "Скачать текущее видео Rutube",
  twitter: "Скачать медиа текущего поста",
  vk: "Скачать текущее видео VK",
} as const;

async function selectedLanguage(): Promise<Language> {
  const { language } = await chrome.storage.local.get("language");
  return language === "ru" || language === "en"
    ? language
    : browserLanguage(navigator.languages);
}

chrome.action.onClicked.addListener((tab) => {
  if (oneClickService(tab.url)) {
    void downloadFromTab(tab);
  } else {
    void openUniversalPopup(tab);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const update = message as {
    progress?: number;
    requestId?: string;
    target?: string;
    type?: string;
  };
  if (sender.id !== chrome.runtime.id || update.target !== "background") return;
  if (update.type !== "gif-progress" || !update.requestId) return;
  const tabId = gifTasks.get(update.requestId);
  const progress = Number(update.progress);
  if (!tabId || !Number.isFinite(progress)) return;

  const percentage = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  void selectedLanguage().then((language) =>
    setBadge(
      tabId,
      String(percentage),
      "#7b2cbf",
      translate(language, "Конвертируем GIF: {percentage}%", { percentage }),
    ),
  );
});

async function updateActionPresentation(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const service = oneClickService(tab.url);
  const language = await selectedLanguage();
  await Promise.all([
    chrome.action.setPopup({ popup: "", tabId: tab.id }),
    chrome.action.setTitle({
      tabId: tab.id,
      title: service
        ? translate(
            language,
            service in DOWNLOAD_TITLES
              ? DOWNLOAD_TITLES[service as keyof typeof DOWNLOAD_TITLES]
              : platformReference(tab.url)?.kind === "live"
                ? "Открыть эфир в qplay"
                : platformReference(tab.url)?.kind === "track"
                  ? "Скачать трек"
                  : "Скачать медиа текущего поста",
          )
        : "qcatch",
    }),
    ...(service
      ? [chrome.action.setBadgeText({ tabId: tab.id, text: "" })]
      : []),
  ]);
  if (service === "rutube") {
    const item = await activeRutubeDownload(tab);
    if (item) await showRutubeDownloadProgress(item);
  }
}

async function activeRutubeDownload(
  tab: chrome.tabs.Tab,
): Promise<QueueItem | undefined> {
  const videoId = parseRutubeVideoUrl(tab.url);
  if (!videoId) return undefined;
  return (await readQueue()).items.find(
    (item) =>
      item.job.player === "Rutube" &&
      item.job.tabId === tab.id &&
      parseRutubeVideoUrl(item.job.pageUrl) === videoId &&
      !["canceled", "completed", "failed"].includes(item.status),
  );
}

export async function showRutubeDownloadProgress(
  item: QueueItem,
): Promise<void> {
  if (item.job.player !== "Rutube") return;
  const percentage = Math.min(99, Math.floor(item.progress * 100));
  const language = await selectedLanguage();
  const t = (message: Message) => translate(language, message, { percentage });
  const presentation = {
    canceled: {
      color: "#777777",
      text: "—",
      title: t("Загрузка видео Rutube отменена"),
    },
    completed: {
      color: "#16833b",
      text: "✓",
      title: t("Видео Rutube скачано"),
    },
    downloading: {
      color: "#1677ff",
      text: `${percentage}%`,
      title: t("Загрузка видео Rutube: {percentage}%"),
    },
    failed: {
      color: "#c62828",
      text: "!",
      title: item.error
        ? errorTranslation(language, item.error).message
        : t(
            "Не удалось скачать видео Rutube. Обновите страницу и повторите загрузку.",
          ),
    },
    preparing: {
      color: "#1677ff",
      text: "…",
      title: t("Подготавливаем видео Rutube…"),
    },
    queued: {
      color: "#1677ff",
      text: "…",
      title: t("Видео Rutube в очереди загрузки"),
    },
    saving: {
      color: "#1677ff",
      text: "99%",
      title: t("Сохраняем видео Rutube…"),
    },
  };
  const badge = presentation[item.status];
  if (item.status === "failed")
    await notify(t("Не удалось скачать видео Rutube"), badge.title).catch(
      () => undefined,
    );
  const tab = await chrome.tabs.get(item.job.tabId).catch(() => undefined);
  if (
    tab &&
    parseRutubeVideoUrl(tab.url) === parseRutubeVideoUrl(item.job.pageUrl)
  ) {
    await setBadge(item.job.tabId, badge.text, badge.color, badge.title);
  }
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading")
    void updateActionPresentation(tab);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then(updateActionPresentation)
    .catch(() => undefined);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.language) {
    void chrome.tabs
      .query({})
      .then((tabs) => Promise.allSettled(tabs.map(updateActionPresentation)));
  }
});

void chrome.tabs
  .query({})
  .then((tabs) => Promise.allSettled(tabs.map(updateActionPresentation)));

async function openUniversalPopup(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;

  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId: tab.id, text: "" }),
      chrome.action.setPopup({ popup: "popup/index.html", tabId: tab.id }),
      chrome.action.setTitle({ tabId: tab.id, title: "qcatch" }),
    ]);
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch {
    const message = translate(
      await selectedLanguage(),
      "Не удалось открыть qcatch. Нажмите иконку ещё раз.",
    );
    await Promise.allSettled([
      setBadge(tab.id, "!", "#c62828", message),
      notify("qcatch", message),
    ]);
  }
}

async function downloadFromTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || activeTabs.has(tab.id)) return;
  const language = await selectedLanguage();
  activeTabs.add(tab.id);

  try {
    const service = oneClickService(tab.url);
    const current =
      service === "rutube" ? await activeRutubeDownload(tab) : undefined;
    if (current) {
      await showRutubeDownloadProgress(current);
      return;
    }
    await setBadge(tab.id, "…", "#1677ff", translate(language, "Ищем медиа…"));
    if (service === "rutube") {
      const job = await prepareRutubeJob(tab);
      await showRutubeDownloadProgress({ job, progress: 0, status: "queued" });
      await enqueueDownloads([job]);
      return;
    }
    if (platformReference(tab.url)) {
      const result = await runPlatform(tab);
      if (result.failure)
        await notify(
          translate(language, "Часть медиа не скачалась"),
          `${translate(language, "Запущено {count} из {total}.", { count: result.downloads ?? 0, total: result.total ?? 0 })} ${errorTranslation(language, result.failure).message}`,
        );
      await setBadge(
        tab.id,
        result.opened ? "▶" : result.job ? "…" : String(result.downloads ?? 0),
        "#16833b",
        translate(
          language,
          result.opened
            ? "Эфир открыт в qplay"
            : result.job
              ? "В очереди"
              : "Запущено загрузок: {count}",
          { count: result.downloads ?? 0 },
        ),
      );
      await openUniversalPopup(tab);
      return;
    }
    const media =
      service === "vk"
        ? [await fetchVkDownload(tab)]
        : await twitterMediaFromTab(tab);
    let startedCount = 0;
    let firstFailure: unknown;

    for (const item of media) {
      try {
        await downloadMedia(item, tab.id);
        startedCount += 1;
      } catch (error) {
        firstFailure ??= error;
      }
    }

    if (startedCount === 0) {
      if (firstFailure instanceof Error) throw firstFailure;
      throw new Error("Браузер не смог начать загрузку.");
    }

    await setBadge(
      tab.id,
      String(startedCount),
      "#16833b",
      translate(language, "Запущено загрузок: {count}", {
        count: startedCount,
      }),
    );
    if (startedCount < media.length) {
      const detail =
        firstFailure instanceof Error
          ? ` ${errorTranslation(language, firstFailure.message).message}`
          : "";
      await notify(
        translate(language, "Часть медиа не скачалась"),
        translate(language, "Запущено {count} из {total}.", {
          count: startedCount,
          total: media.length,
        }) + detail,
      );
    }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "Не удалось скачать медиа с этой страницы.";
    const message = errorTranslation(language, detail).message;
    await Promise.allSettled([
      setBadge(tab.id, "!", "#c62828", message),
      notify("qcatch", message),
    ]);
    if (platformReference(tab.url)) await openUniversalPopup(tab);
  } finally {
    activeTabs.delete(tab.id);
  }
}

async function twitterMediaFromTab(
  tab: chrome.tabs.Tab,
): Promise<MediaDownload[]> {
  try {
    return await fetchTwitterMedia(tab.url ?? "");
  } catch (error) {
    if (
      !(error instanceof TwitterMediaError) ||
      !["fetch-failed", "no-downloadable-media", "no-media"].includes(
        error.code,
      )
    ) {
      throw error;
    }
    if (tab.id === undefined) throw error;
    const capture = (await readTabState(tab.id)).twitter;
    if (!capture || capture.tweetId !== parseTwitterPostUrl(tab.url)?.id)
      throw error;
    return twitterMediaToDownloads(tab.url ?? "", capture.media);
  }
}

async function downloadMedia(
  item: MediaDownload,
  tabId: number,
): Promise<number> {
  const url = item.convertToGif ? await convertGif(item.url, tabId) : item.url;
  return chrome.downloads.download({
    conflictAction: "uniquify",
    filename: item.filename,
    saveAs: false,
    url,
  });
}

async function convertGif(url: string, tabId: number): Promise<string> {
  await setBadge(
    tabId,
    "GIF",
    "#7b2cbf",
    translate(await selectedLanguage(), "Подготавливаем GIF…"),
  );
  const requestId = crypto.randomUUID();
  gifTasks.set(requestId, tabId);

  try {
    await ensureOffscreenDocument();
    const response = (await chrome.runtime.sendMessage({
      requestId,
      target: "offscreen",
      type: "convert-gif",
      url,
    })) as { error?: string; ok?: boolean; url?: string } | undefined;
    if (response?.ok && typeof response.url === "string") return response.url;
    throw new Error(response?.error ?? "The converter returned no file.");
  } catch {
    throw new TwitterMediaError(
      "gif-conversion-failed",
      "Не удалось преобразовать зацикленное видео в GIF.",
    );
  } finally {
    gifTasks.delete(requestId);
  }
}

async function setBadge(
  tabId: number,
  text: string,
  color: string,
  title: string,
): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}

async function notify(title: string, message: string): Promise<void> {
  await chrome.notifications.create({
    iconUrl: "icons/icon-128.png",
    message,
    title,
    type: "basic",
  });
}
