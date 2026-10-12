import { buildCurrentJob } from "../shared/jobs.ts";
import { publicUrl, type Selection } from "../shared/connection.ts";
import { youtubeVideoUrl } from "../shared/youtube.ts";
import type { DownloadJob } from "../shared/types.ts";
import type { IntegrationMessage, ProductSelection } from "../shared/integration.ts";
import { readTabState } from "./state.ts";
import { bridgeRequest, NativeBridgeError } from "./native.ts";
import { captureYoutubePlayback } from "./youtube.ts";
import { performProductAction, readProductActions } from "./product-actions.ts";

export type { IntegrationMessage } from "../shared/integration.ts";

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
  frames?: Array<{ frameId: number; documentId?: string; identity: FrameIdentity }>;
  resources?: Array<{ id: string; frameId: number; documentId: string; url: string }>;
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

async function selected(message: ProductSelection) {
  const state = await readTabState(message.tabId);
  if ((await chrome.tabs.get(message.tabId)).url !== state.page.url) throw new Error("Страница изменилась. Откройте qcatch заново.");
  if (!message.sourceId) throw new Error("Выберите источник видео.");
  for (const [ids, kind] of [[message.audioIds, "audio"], [message.subtitleIds, "subtitle"]] as const) {
    if (!ids.every((id) => state.resources.some((resource) => resource.id === id && resource.kind === kind))) {
      throw new Error("Источник устарел. Откройте qcatch заново.");
    }
  }
  const job = buildCurrentJob(state, message.sourceId, message.audioIds, message.subtitleIds, "mkv");
  const ids = new Set([message.sourceId, ...message.audioIds, ...message.subtitleIds]);
  return { job, resources: state.resources.filter((resource) => ids.has(resource.id)) };
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
  if (message.type === "integration:state") return readProductActions(message.tabId);
  return performProductAction(message,
    message.type === "media:play" ? "play" : message.action,
    message.previousId, () => prepareProductAction(message));
}

async function requestOpening(path: string, body: unknown): Promise<void> {
  const result = await bridgeRequest(path, body) as { opened?: boolean };
  if (result.opened !== true) {
    throw new NativeBridgeError("Ответ приложения не удалось прочитать.", true);
  }
}

async function prepareProductAction(message: Exclude<IntegrationMessage,
  { type: "integration:health" | "integration:state" }>): Promise<() => Promise<void>> {
  const tab = await chrome.tabs.get(message.tabId);
  const pageUrl = sourcePage(tab.url ?? "");
  if (sourcePage(message.pageUrl) !== pageUrl) throw new Error("Страница изменилась. Откройте qcatch заново.");
  const binding: CaptureBinding = { tabId: message.tabId, pageUrl, created: Date.now() };
  if (youtubeVideoUrl(pageUrl)) {
    binding.youtube = true;
    binding.frames = [{ frameId: 0, identity: await chrome.tabs.sendMessage(message.tabId,
      { type: "capture:identity" }, { frameId: 0 }) as FrameIdentity }];
  } else {
    const capture = await selected(message);
    binding.job = capture.job;
    binding.resources = capture.resources
      .map(({ id, frameId, documentId, url }) => {
        if (!documentId) throw new Error("Обновите страницу и снова выберите видео в qcatch.");
        return { id, frameId, documentId, url };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const frames = [...new Map(binding.resources.map(({ frameId, documentId }) =>
      [documentId, { frameId, documentId }])).values()].sort((left, right) => left.frameId - right.frameId);
    binding.frames = await Promise.all(frames.map(async (frame) => ({
      ...frame,
      identity: await chrome.tabs.sendMessage(message.tabId, { type: "capture:identity" }, frame)
        .catch(() => { throw new Error("capture_expired"); }) as FrameIdentity,
    })));
  }
  await validateCapture(binding);

  if (message.type === "media:play") {
    if (binding.youtube) {
      const payload = await captureYoutubePlayback(message.tabId, pageUrl);
      return async () => {
        await validateCapture(binding);
        await requestOpening("/play", payload);
      };
    }
    const job = binding.job!;
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
    return async () => {
      await validateCapture(binding);
      await requestOpening("/play-media", { ...resolved, cookies: [...cookies.values()] });
    };
  }
  if (binding.job) {
    if (binding.job.inputs.length > 2) throw new Error("qbutt currently supports one external audio track. Select one audio track and try again.");
    if (await privateTrackCredentials(binding.job)) throw new Error("These audio or subtitle tracks require separate sign-in. Download them through qcatch instead.");
  }
  return async () => {
    await validateCapture(binding);
    const entries = await chrome.storage.session.get(null);
    const expired = Object.entries(entries).filter(([key, value]) => key.startsWith("capture:")
      && Date.now() - (value as CaptureBinding).created > 10 * 60_000).map(([key]) => key);
    if (expired.length) await chrome.storage.session.remove(expired);
    if (Object.keys(entries).filter((key) => key.startsWith("capture:")).length - expired.length >= 64) {
      throw new Error("Слишком много недавних передач. Повторите через несколько минут.");
    }
    const captureId = crypto.randomUUID();
    await chrome.storage.session.set({ [`capture:${captureId}`]: binding });
    const payload = { v: 1, pageUrl, title: tab.title ?? "Видео из браузера", action: message.action, captureId };
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    await requestOpening("/handoff", { uri: `qbutt://capture?d=${encoded}` });
  };
}

async function validateCapture(binding: CaptureBinding): Promise<void> {
  const tab = await chrome.tabs.get(binding.tabId).catch(() => undefined);
  try {
    if (sourcePage(tab?.url ?? "") !== binding.pageUrl) throw new Error("capture_expired");
  } catch {
    throw new Error("capture_expired");
  }
  if (!binding.frames) throw new Error("capture_expired");
  for (const frame of binding.frames) {
    if (!frame.identity?.documentId || !Array.isArray(frame.identity.media)) throw new Error("capture_expired");
    const identity = await chrome.tabs.sendMessage(binding.tabId, { type: "capture:identity" }, {
      frameId: frame.frameId, ...(frame.documentId ? { documentId: frame.documentId } : {}),
    })
      .catch(() => { throw new Error("capture_expired"); }) as FrameIdentity | undefined;
    if (!identity || identity.url !== frame.identity.url || identity.documentId !== frame.identity.documentId
      || JSON.stringify(identity.media) !== JSON.stringify(frame.identity.media)) throw new Error("capture_expired");
  }
  if (binding.youtube) return;
  if (!binding.job || !binding.resources) throw new Error("capture_expired");
  const state = await readTabState(binding.tabId);
  if (!binding.resources.every((selected) => state.resources.some((resource) =>
    resource.id === selected.id && resource.frameId === selected.frameId
      && resource.documentId === selected.documentId && resource.url === selected.url))) throw new Error("capture_expired");
}

export async function resolveCapture(pageUrl: string, selection: Selection) {
  const id = selection.captureId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("capture_expired");
  const binding = (await chrome.storage.session.get(`capture:${id}`))[`capture:${id}`] as CaptureBinding | undefined;
  if (!binding || binding.pageUrl !== pageUrl || Date.now() - binding.created > 10 * 60_000) throw new Error("capture_expired");
  await validateCapture(binding);
  if (binding.youtube) {
    const cookies = (await chrome.cookies.getAll({ url: pageUrl })).filter((cookie) => !cookie.partitionKey);
    return { kind: "video", resolver: "yt-dlp", url: youtubeVideoUrl(pageUrl), selection: { captureId: id },
      headers: { "User-Agent": navigator.userAgent, ...(cookies.length ? { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") } : {}) } };
  }
  const job = binding.job!;
  const resolved = media(job);
  if (resolved.audio.length > 1) throw new Error("unsupported_multi_audio");
  if (await privateTrackCredentials(job)) throw new Error("unsupported_private_tracks");
  const cookies = (await chrome.cookies.getAll({ url: resolved.url })).filter((cookie) => !cookie.partitionKey);
  if (cookies.length) resolved.headers.push(["Cookie", cookies.map(({ name, value }) => `${name}=${value}`).join("; ")]);
  return {
    kind: "video", resolver: "direct", url: resolved.url, headers: Object.fromEntries(resolved.headers),
    ...(resolved.audio[0] ? { audioUrl: resolved.audio[0] } : {}),
    subtitles: job.subtitles.map((subtitle) => ({ title: subtitle.name, url: subtitle.url, language: subtitle.language })),
    selection: { captureId: id },
  };
}
