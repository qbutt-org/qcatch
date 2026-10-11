import "../connection/background.ts";
import { normalizedHeaders } from "../shared/media.ts";
import { planYummyJobs } from "../shared/jobs.ts";
import type { BackgroundMessage, CapturePayload, YummyCatalog } from "../shared/types.ts";
import { sendYummyMessage } from "./content.ts";
import { saveDownload } from "./download.ts";
import { enqueueDownloads, ensureOffscreenDocument, prepareReplay, releaseReplay } from "./engine.ts";
import { readPreferences, removePreferences, writePreferences } from "./preferences.ts";
import { addQueueJobs, readQueue, updateQueueItem } from "./queue.ts";
import {
  addCapture,
  addWebRequestCapture,
  readTabState,
  resetTabState,
  updatePage,
  updateTwitterCapture,
} from "./state.ts";
import { estimateYummyBatch, invalidateYummyEstimates, prepareYummyJob, withYummyTabLock } from "./yummy.ts";
import { showRutubeDownloadProgress } from "./action.ts";
import { handleYoutubeMessage } from "./youtube.ts";
import type { YoutubeMessage } from "../shared/youtube.ts";
import { handleIntegration, removeTabCaptures, type IntegrationMessage } from "./integration.ts";
import { handlePlatformMessage, type PlatformMessage } from "./platforms.ts";

const requestHeaders = new Map<string, chrome.webRequest.HttpHeader[]>();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    requestHeaders.set(details.requestId, normalizedHeaders(details.requestHeaders));
    return undefined;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = requestHeaders.get(details.requestId) ?? [];
    requestHeaders.delete(details.requestId);
    void addWebRequestCapture(details, headers);
    return undefined;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  requestHeaders.delete(details.requestId);
}, { urls: ["<all_urls>"] });

chrome.webRequest.onCompleted.addListener((details) => {
  requestHeaders.delete(details.requestId);
}, { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.all([
    chrome.storage.session.remove(`tab:${tabId}`),
    chrome.storage.session.remove(`youtube:${tabId}`),
    removePreferences(tabId),
    removeTabCaptures(tabId),
  ]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void resetTabState(tabId);
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (!rawMessage || typeof rawMessage !== "object") return;
  if ((rawMessage as { target?: string }).target === "offscreen") return;
  const type = (rawMessage as { type?: unknown }).type;
  if (typeof type !== "string" || !["platform:", "youtube:", "integration:", "media:", "bridge:", "state:", "preferences:", "queue:", "yummy:", "engine:", "download:"].some((prefix) => type.startsWith(prefix))) return;
  const message = rawMessage as BackgroundMessage;
  const tabId = sender.tab?.id;

  const handle = async (): Promise<unknown> => {
    if (type.startsWith("platform:")) {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup/index.html")) {
        throw new Error("Управление загрузками доступно только из qcatch.");
      }
      return handlePlatformMessage(rawMessage as PlatformMessage);
    }
    if (type.startsWith("integration:") || type.startsWith("media:")) {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup/index.html")) {
        throw new Error("Управление приложениями доступно только из qcatch.");
      }
      return handleIntegration(rawMessage as IntegrationMessage);
    }
    if (typeof message.type === "string" && message.type.startsWith("youtube:")) {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup/index.html")) {
        throw new Error("Управление загрузками YouTube доступно только из popup расширения.");
      }
      return handleYoutubeMessage(message as YoutubeMessage);
    }
    switch (message.type) {
      case "bridge:capture":
        if (tabId === undefined) return undefined;
        return addCapture(tabId, sender.frameId ?? 0, message.payload as CapturePayload);
      case "bridge:page":
        if (tabId === undefined) return undefined;
        return updatePage(tabId, message.page);
      case "bridge:twitter":
        if (tabId === undefined) return undefined;
        return updateTwitterCapture(tabId, message.capture);
      case "state:get":
        return readTabState(message.tabId);
      case "preferences:get":
        return readPreferences(message.tabId, message.pageUrl);
      case "preferences:set":
        await writePreferences(message.tabId, message.preferences);
        return { saved: true };
      case "queue:get":
        return readQueue();
      case "yummy:options":
        return withYummyTabLock(message.tabId, () => sendYummyMessage(message.tabId, { type: "yummy:options" }));
      case "yummy:catalog":
        invalidateYummyEstimates(message.tabId);
        return withYummyTabLock(message.tabId, () => sendYummyMessage(message.tabId, {
          player: message.player,
          type: "yummy:catalog",
        }));
      case "queue:add":
        return enqueueDownloads(message.jobs);
      case "yummy:batch": {
        invalidateYummyEstimates(message.request.tabId);
        const state = await readTabState(message.request.tabId);
        if (state.page.url !== message.request.pageUrl) {
          throw new Error("Страница аниме изменилась. Откройте popup заново и повторите загрузку.");
        }
        const jobs = planYummyJobs({
          container: "mkv",
          episodes: message.request.episodes,
          pageUrl: state.page.url,
          player: message.request.context.player,
          tabId: message.request.tabId,
          title: message.request.context.title,
          yummySources: message.request.selectedSources,
        });
        const queue = await addQueueJobs(jobs, "preparing");
        try {
          const catalog = await withYummyTabLock(message.request.tabId, () => sendYummyMessage<YummyCatalog & { error?: string }>(message.request.tabId, {
            player: message.request.context.player,
            selectedSources: message.request.selectedSources,
            type: "yummy:catalog",
          }));
          if (catalog.error) throw new Error(catalog.error);
          if ((await readTabState(message.request.tabId)).page.url !== message.request.pageUrl) {
            throw new Error("Страница аниме изменилась. Откройте popup заново и повторите загрузку.");
          }
          await ensureOffscreenDocument();
          await chrome.runtime.sendMessage({
            jobs,
            request: { ...message.request, context: catalog.context, sources: catalog.sources },
            target: "offscreen",
            type: "offscreen:yummy-batch",
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await Promise.all(jobs.map((job) => updateQueueItem(job.id, "failed", 0, reason)));
          throw error;
        }
        return { jobs, queue };
      }
      case "yummy:estimate":
        return estimateYummyBatch(message.request);
      case "yummy:prepare-one": {
        const job = await prepareYummyJob(message.request, message.job);
        return job ? { job } : { canceled: true };
      }
      case "queue:cancel":
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ jobId: message.jobId, target: "offscreen", type: "offscreen:cancel" });
        return updateQueueItem(message.jobId, "canceled", 0);
      case "queue:update": {
        const previous = (await readQueue()).items.find((item) => item.job.id === message.jobId);
        const queue = await updateQueueItem(message.jobId, message.status, message.progress, message.error);
        if (previous && (previous.status !== message.status || previous.error !== message.error
          || Math.floor(previous.progress * 100) !== Math.floor(message.progress * 100))) {
          await showRutubeDownloadProgress({
            job: previous.job,
            progress: message.progress,
            status: message.status,
            ...(message.error ? { error: message.error } : {}),
          }).catch(() => undefined);
        }
        return queue;
      }
      case "engine:prepare":
        await prepareReplay(message.job);
        return { ready: true };
      case "engine:release":
        await releaseReplay();
        return { released: true };
      case "download:save":
        if (sender.url !== chrome.runtime.getURL("offscreen/index.html")) {
          throw new Error("Сохранение файла разрешено только внутреннему обработчику");
        }
        return { downloadId: await saveDownload(message.filename, message.url) };
      default:
        return undefined;
    }
  };

  void handle().then(sendResponse).catch((error: unknown) => {
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
