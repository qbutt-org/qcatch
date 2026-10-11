import {
  platformReference,
  PLATFORM_NAMES,
  type PlatformReference,
} from "../shared/platforms.ts";
import {
  NATIVE_BRIDGE_PROTOCOL,
  type NativeHealth,
  type NativeJob,
} from "../shared/native.ts";
import type { DownloadJob } from "../shared/types.ts";
import { bridgeRequest } from "./native.ts";
import { enqueueDownloads } from "./engine.ts";
import { platformAssets, type PlatformAsset } from "./platform-assets.ts";
import { readQueue } from "./queue.ts";

export type PlatformMessage =
  | { type: "platform:run"; tabId: number; url: string }
  | { type: "platform:jobs" }
  | { type: "platform:cancel" | "platform:reveal"; jobId: string };

export type PlatformResult = {
  opened?: boolean;
  job?: NativeJob;
  downloads?: number;
  total?: number;
  failure?: string;
};

const activeRuns = new Map<string, Promise<PlatformResult>>();

async function sourceCookies(reference: PlatformReference) {
  // Keep domain/path/secure scope; only the selected service goes to its local extractor.
  const domains = {
    tiktok: ["tiktok.com"],
    reddit: ["reddit.com"],
    twitch: ["twitch.tv"],
    soundcloud: ["soundcloud.com"],
    yandexmusic: [new URL(reference.url).hostname.replace(/^music\./, "")],
    instagram: [],
    pinterest: [],
    vkmusic: [],
  }[reference.service];
  const cookies = (
    await Promise.all(
      domains.map((domain) => chrome.cookies.getAll({ domain })),
    )
  ).flat();
  return cookies
    .filter((cookie) => !cookie.partitionKey)
    .map(({ domain, path, name, value, secure, expirationDate, hostOnly }) => ({
      domain,
      path,
      name,
      value,
      secure,
      host_only: hostOnly,
      expires: expirationDate ?? null,
    }));
}

async function exactTrackPage(
  tab: chrome.tabs.Tab,
  reference: PlatformReference,
): Promise<PlatformReference> {
  if (
    reference.service !== "yandexmusic" ||
    !new URL(reference.url).pathname.startsWith("/track/")
  )
    return reference;
  const [script] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: () =>
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ??
      document.querySelector<HTMLMetaElement>('meta[property="og:url"]')
        ?.content,
  });
  const canonical = platformReference(script?.result);
  if (
    !canonical ||
    canonical.service !== reference.service ||
    canonical.id !== reference.id ||
    !new URL(canonical.url).pathname.startsWith("/album/")
  ) {
    throw new Error("Open this track from its Yandex Music album, then retry.");
  }
  return canonical;
}

export function runPlatform(tab: chrome.tabs.Tab): Promise<PlatformResult> {
  const key = `${tab.id}:${tab.url}`;
  const pending = activeRuns.get(key);
  if (pending) return pending;
  const operation = preparePlatform(tab).finally(() => activeRuns.delete(key));
  activeRuns.set(key, operation);
  return operation;
}

async function preparePlatform(tab: chrome.tabs.Tab): Promise<PlatformResult> {
  if (tab.id === undefined || !tab.url)
    throw new Error("Open the source page and retry.");
  let reference = platformReference(tab.url);
  if (!reference)
    throw new Error("Open one supported post, clip or track and retry.");
  reference = await exactTrackPage(tab, reference);
  const browserAssets =
    ["instagram", "pinterest", "vkmusic"].includes(reference.service) ||
    (reference.service === "reddit" &&
      new URL(reference.url).pathname.includes("/comments/")) ||
    (reference.service === "tiktok" &&
      new URL(reference.url).pathname.includes("/photo/"));
  if (browserAssets) {
    const pending = (await readQueue()).items.filter(
      (item) =>
        item.job.tabId === tab.id &&
        item.job.pageUrl === reference.url &&
        !["completed", "failed", "canceled"].includes(item.status),
    );
    if (pending.length) return { downloads: pending.length };
    const assets = await platformAssets(tab, reference);
    if (assets) return downloadBrowserAssets(tab.id, reference, assets);
  }
  const health = (await bridgeRequest("/health")) as NativeHealth;
  if (health.protocol !== NATIVE_BRIDGE_PROTOCOL)
    throw new Error(
      "Обновите qcatch: версия помощника несовместима с расширением.",
    );
  const body = { url: reference.url, cookies: await sourceCookies(reference) };
  if (reference.kind === "live") {
    if (!health.qplayInstalled)
      throw new Error("qplay is not installed. Install qplay and try again.");
    await bridgeRequest("/services/play", body);
    return { opened: true };
  }
  return { job: (await bridgeRequest("/services/jobs", body)) as NativeJob };
}

async function downloadBrowserAssets(
  tabId: number,
  reference: PlatformReference,
  assets: PlatformAsset[],
): Promise<PlatformResult> {
  const jobs: DownloadJob[] = [];
  let direct = 0;
  let failure: unknown;
  for (const asset of assets) {
    if (asset.kind === "photo" || asset.kind === "gif") {
      try {
        await chrome.downloads.download({
          url: asset.url,
          filename: asset.filename,
          conflictAction: "uniquify",
          saveAs: false,
          headers: [
            {
              name: "Accept",
              value:
                asset.kind === "gif"
                  ? "image/gif,image/*;q=0.9,*/*;q=0.1"
                  : "image/*,*/*;q=0.1",
            },
          ],
        });
        direct += 1;
      } catch (error) {
        failure ??= error;
      }
      continue;
    }
    const audioOnly = asset.audioOnly === true || asset.kind === "audio";
    jobs.push({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      tabId,
      pageUrl: reference.url,
      title: asset.filename.replace(/\.[^.]+$/, ""),
      player: PLATFORM_NAMES[reference.service],
      container: "mp4",
      filename: audioOnly
        ? asset.filename.replace(/\.[^.]+$/, ".m4a")
        : asset.filename,
      inputs: [
        {
          url: asset.url,
          kind: asset.kind,
          role: audioOnly ? "audio" : "media",
          headers: [{ name: "Referer", value: reference.url }],
        },
      ],
      subtitles: [],
      ...(asset.duration ? { expectedDuration: asset.duration } : {}),
    });
  }
  let queued = 0;
  for (const job of jobs) {
    try {
      await enqueueDownloads([job]);
      queued += 1;
    } catch (error) {
      failure ??= error;
    }
  }
  if (!direct && !queued)
    throw failure ?? new Error("The browser could not start the download.");
  return {
    downloads: direct + queued,
    ...(failure
      ? {
          total: assets.length,
          failure: failure instanceof Error ? failure.message : String(failure),
        }
      : {}),
  };
}

export async function handlePlatformMessage(
  message: PlatformMessage,
): Promise<unknown> {
  if (message.type === "platform:jobs") return bridgeRequest("/jobs");
  if (message.type === "platform:run") {
    const tab = await chrome.tabs.get(message.tabId);
    const reference = platformReference(message.url);
    if (!reference || platformReference(tab.url)?.url !== reference.url) {
      throw new Error("The page changed. Open the media again and retry.");
    }
    return runPlatform(tab);
  }
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(message.jobId))
    throw new Error("Неизвестная загрузка.");
  return bridgeRequest(
    `/jobs/${message.jobId}/${message.type === "platform:cancel" ? "cancel" : "reveal"}`,
    {},
  );
}
