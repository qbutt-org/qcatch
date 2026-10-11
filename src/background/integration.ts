import { buildCurrentJob } from "../shared/jobs.ts";
import { publicUrl, type Selection } from "../shared/connection.ts";
import { youtubeVideoUrl } from "../shared/youtube.ts";
import type { DownloadJob } from "../shared/types.ts";
import { readTabState } from "./state.ts";
import { bridgeRequest } from "./native.ts";

export type IntegrationMessage =
  | { type: "integration:health" }
  | { type: "media:play"; tabId: number; sourceId: string; audioIds: string[]; subtitleIds: string[] }
  | { type: "integration:handoff"; tabId: number; sourceId?: string; audioIds?: string[]; subtitleIds?: string[]; action: "watch" | "download" };

interface FrameIdentity {
  url: string;
  documentId: string;
  media: string[];
}

interface CaptureBinding {
  tabId: number;
  pageUrl: string;
  created: number;
  youtube?: true;
  job?: DownloadJob;
  frameId?: number;
  identity?: FrameIdentity;
}

interface PlaybackCookie {
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  host_only: boolean;
  expires: number | null;
}

export async function removeTabCaptures(tabId: number): Promise<void> {
  const entries = await chrome.storage.session.get(null);
  const keys = Object.entries(entries).filter(([key, value]) => key.startsWith("capture:")
    && (value as CaptureBinding).tabId === tabId).map(([key]) => key);
  if (keys.length) await chrome.storage.session.remove(keys);
}

function sourcePage(value: string): string {
  const url = new URL(publicUrl(value));
  if ([...url.searchParams.keys()].some((key) => /(?:token|passkey|password|secret|auth|cookie|signature|api.?key)|^(?:key|sig|expires|policy|x-amz-.+|x-goog-.+)$/i.test(key))) {
    throw new Error("Откройте постоянную страницу видео без временной ссылки доступа.");
  }
  url.hash = "";
  return youtubeVideoUrl(url.href) ?? url.href;
}

async function selected(message: { tabId: number; sourceId: string; audioIds: string[]; subtitleIds: string[] }): Promise<DownloadJob> {
  const state = await readTabState(message.tabId);
  if ((await chrome.tabs.get(message.tabId)).url !== state.page.url) throw new Error("Страница изменилась. Откройте qcatch заново.");
  return buildCurrentJob(state, message.sourceId, message.audioIds, message.subtitleIds, "mkv");
}

function media(job: DownloadJob) {
  const main = job.inputs[0];
  if (!main) throw new Error("Выберите источник видео.");
  const headers = new Map(main.headers.map(({ name, value }) => [name, value]));
  headers.set("User-Agent", navigator.userAgent);
  return {
    url: publicUrl(main.url),
    headers: [...headers],
    audio: job.inputs.slice(1).map((input) => publicUrl(input.url)),
    subtitles: job.subtitles.map((subtitle) => publicUrl(subtitle.url)),
  };
}

async function privateTrackCredentials(job: DownloadJob): Promise<boolean> {
  const origin = new URL(job.inputs[0]!.url).origin;
  for (const source of [...job.inputs.slice(1), ...job.subtitles]) {
    if (source.headers.some(({ name }) => /^(?:authorization|authorizations|x-)/i.test(name))) return true;
    if (new URL(source.url).origin !== origin
      && (await chrome.cookies.getAll({ url: source.url })).some((cookie) => !cookie.partitionKey)) return true;
  }
  return false;
}

export async function handleIntegration(message: IntegrationMessage): Promise<unknown> {
  if (message.type === "integration:health") return bridgeRequest("/health");
  if (message.type === "media:play") {
    const job = await selected(message);
    const resolved = media(job);
    if ([...job.inputs, ...job.subtitles].some((source) =>
      source.headers.some(({ name }) => /^(?:authorization|authorizations|x-)/i.test(name)))) {
      throw new Error("This source requires private request headers. Download it through qcatch instead.");
    }
    const cookies = new Map<string, PlaybackCookie>();
    for (const source of [...job.inputs, ...job.subtitles]) {
      for (const cookie of await chrome.cookies.getAll({ url: source.url })) {
        if (cookie.partitionKey) continue;
        cookies.set(`${cookie.domain}\n${cookie.path}\n${cookie.name}`, {
          domain: cookie.domain,
          path: cookie.path,
          name: cookie.name,
          value: cookie.value,
          secure: cookie.secure,
          host_only: cookie.hostOnly,
          expires: cookie.expirationDate ?? null,
        });
      }
    }
    return bridgeRequest("/play-media", { ...resolved, cookies: [...cookies.values()] });
  }
  const tab = await chrome.tabs.get(message.tabId);
  const pageUrl = sourcePage(tab.url ?? "");
  const youtube = youtubeVideoUrl(pageUrl);
  const binding: CaptureBinding = { tabId: message.tabId, pageUrl, created: Date.now() };
  if (youtube) {
    binding.youtube = true;
  } else {
    if (!message.sourceId) throw new Error("Выберите точный источник для передачи в qbutt.");
    binding.job = await selected({ tabId: message.tabId, sourceId: message.sourceId,
      audioIds: message.audioIds ?? [], subtitleIds: message.subtitleIds ?? [] });
    if (binding.job.inputs.length > 2) throw new Error("qbutt currently supports one external audio track. Select one audio track and try again.");
    if (await privateTrackCredentials(binding.job)) throw new Error("These audio or subtitle tracks require separate sign-in. Download them through qcatch instead.");
    const state = await readTabState(message.tabId);
    const resource = state.resources.find((resource) => resource.id === message.sourceId);
    if (!resource) throw new Error("Источник устарел. Откройте qcatch заново.");
    binding.frameId = resource.frameId;
    binding.identity = await chrome.tabs.sendMessage(message.tabId, { type: "capture:identity" }, { frameId: resource.frameId }) as FrameIdentity;
  }
  const captureId = crypto.randomUUID();
  const entries = await chrome.storage.session.get(null);
  const expired = Object.entries(entries).filter(([key, value]) => key.startsWith("capture:")
    && Date.now() - (value as CaptureBinding).created > 10 * 60_000).map(([key]) => key);
  if (expired.length) await chrome.storage.session.remove(expired);
  if (Object.keys(entries).filter((key) => key.startsWith("capture:")).length - expired.length >= 64) {
    throw new Error("Слишком много недавних передач. Повторите через несколько минут.");
  }
  await chrome.storage.session.set({ [`capture:${captureId}`]: binding });
  const payload = { v: 1, pageUrl, title: tab.title ?? "Видео из браузера", action: message.action, captureId };
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return bridgeRequest("/handoff", { uri: `qbutt://capture?d=${encoded}` });
}

export async function resolveCapture(pageUrl: string, selection: Selection) {
  const id = selection.captureId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("capture_expired");
  const binding = (await chrome.storage.session.get(`capture:${id}`))[`capture:${id}`] as CaptureBinding | undefined;
  if (!binding || binding.pageUrl !== pageUrl || Date.now() - binding.created > 10 * 60_000) throw new Error("capture_expired");
  const tab = await chrome.tabs.get(binding.tabId).catch(() => undefined);
  try {
    if (sourcePage(tab?.url ?? "") !== binding.pageUrl) throw new Error("capture_expired");
  } catch {
    throw new Error("capture_expired");
  }
  if (binding.youtube) {
    const cookies = (await chrome.cookies.getAll({ url: pageUrl })).filter((cookie) => !cookie.partitionKey);
    return { kind: "video", resolver: "yt-dlp", url: youtubeVideoUrl(pageUrl), selection: { captureId: id },
      headers: { "User-Agent": navigator.userAgent, ...(cookies.length ? { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") } : {}) } };
  }
  if (!binding.job || binding.frameId === undefined || !binding.identity) throw new Error("capture_expired");
  const identity = await chrome.tabs.sendMessage(binding.tabId, { type: "capture:identity" }, { frameId: binding.frameId })
    .catch(() => { throw new Error("capture_expired"); }) as FrameIdentity;
  if (identity.url !== binding.identity.url || identity.documentId !== binding.identity.documentId
    || JSON.stringify(identity.media) !== JSON.stringify(binding.identity.media)) throw new Error("capture_expired");
  const state = await readTabState(binding.tabId);
  if (!binding.job.inputs.every((input) => state.resources.some((resource) => resource.url === input.url))) throw new Error("capture_expired");
  const resolved = media(binding.job);
  if (resolved.audio.length > 1) throw new Error("unsupported_multi_audio");
  if (await privateTrackCredentials(binding.job)) throw new Error("unsupported_private_tracks");
  const cookies = (await chrome.cookies.getAll({ url: resolved.url })).filter((cookie) => !cookie.partitionKey);
  if (cookies.length) resolved.headers.push(["Cookie", cookies.map(({ name, value }) => `${name}=${value}`).join("; ")]);
  return {
    kind: "video", resolver: "direct", url: resolved.url, headers: Object.fromEntries(resolved.headers),
    ...(resolved.audio[0] ? { audioUrl: resolved.audio[0] } : {}),
    subtitles: binding.job.subtitles.map((subtitle) => ({ title: subtitle.name, url: subtitle.url, language: subtitle.language })),
    selection: { captureId: id },
  };
}
