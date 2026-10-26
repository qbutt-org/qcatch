import "../connection/content.ts";
import "../connection/document-fetch.ts";
import { classifyMedia, detectProvider, normalizedHeaders } from "../shared/media.ts";
import { validateTwitterCapture } from "../shared/twitter-media.ts";
import { validateTikTokPhotos } from "../shared/tiktok-photos.ts";
import type { BackgroundMessage, CapturePayload, YummyProbeSource, YummySource } from "../shared/types.ts";
import {
  collectYummyCatalog,
  discoverYummyOptions,
  listenForAllohaCatalogRequests,
  preferMaximumAllohaProbeQuality,
  probeYummyEpisode,
  scanPageContext,
} from "./yummy.ts";

const CAPTURE_CHANNEL = "qcatch:capture";
const TWITTER_CHANNEL = "qcatch:twitter";
const MAX_CAPTURE_BODY = 4 * 1024 * 1024;

function send(message: BackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function pageCapture(value: unknown): CapturePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || candidate.url.length > 16_384 || !/^https?:/i.test(candidate.url)) return undefined;
  const body = typeof candidate.body === "string" && candidate.body.length <= MAX_CAPTURE_BODY ? candidate.body : "";
  const contentType = typeof candidate.contentType === "string" ? candidate.contentType.slice(0, 256) : "";
  const method = typeof candidate.method === "string" ? candidate.method.slice(0, 16) : "";
  const headers = Array.isArray(candidate.headers) ? normalizedHeaders(candidate.headers.slice(0, 64)) : [];
  const status = typeof candidate.status === "number" && Number.isInteger(candidate.status)
    ? Math.max(0, Math.min(599, candidate.status))
    : undefined;
  const probe = currentYummyProbe();
  return {
    detectedAt: Date.now(),
    initiator: location.href,
    kind: classifyMedia(candidate.url, contentType, body),
    provider: detectProvider(candidate.url, location.href),
    referer: document.referrer || location.href,
    url: candidate.url,
    ...(body ? { body } : {}),
    ...(contentType ? { contentType } : {}),
    ...(method ? { method } : {}),
    ...(headers.length ? { headers } : {}),
    ...(probe ? { probe } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function currentYummyProbe(): CapturePayload["probe"] {
  const parameters = new URL(location.href).searchParams;
  const episode = Number(parameters.get("sc_probe"));
  const sourceId = parameters.get("sc_source");
  return Number.isInteger(episode) && episode > 0 && sourceId !== null ? { episode, sourceId } : undefined;
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  const data = event.data as { capture?: unknown; channel?: unknown; payload?: unknown };
  if (data.channel === CAPTURE_CHANNEL) {
    const payload = pageCapture(data.payload);
    if (payload) send({ payload, type: "bridge:capture" });
    return;
  }
  if (data.channel === TWITTER_CHANNEL) {
    const capture = validateTwitterCapture(data.capture, location.href);
    if (capture) send({ capture, type: "bridge:twitter" });
  }
  if (data.channel === "qcatch:tiktok-photos" && window === window.top) {
    const capture = validateTikTokPhotos(data.capture, location.href);
    if (capture) send({ capture, type: "bridge:tiktok-photos" });
  }
});

async function captureDomMedia(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const probe = currentYummyProbe();
  for (const element of document.querySelectorAll<HTMLMediaElement>("audio,video")) {
    for (const url of [element.currentSrc, element.src]) {
      if (!url || !/^https?:/i.test(url)) continue;
      pending.push(send({
        payload: {
          detectedAt: Date.now(),
          initiator: location.href,
          kind: classifyMedia(url),
          provider: detectProvider(url, location.href),
          referer: document.referrer || location.href,
          url,
          ...(probe ? { probe } : {}),
        },
        type: "bridge:capture",
      }));
    }

    for (const track of element.querySelectorAll<HTMLTrackElement>("track[src]")) {
      pending.push(send({
        payload: {
          contentType: "text/vtt",
          detectedAt: Date.now(),
          initiator: location.href,
          kind: "subtitle",
          default: track.default,
          forced: track.kind === "captions" && /forced|надписи|форс/i.test(track.label),
          language: track.srclang || "und",
          name: track.label || "Субтитры",
          provider: detectProvider(track.src, location.href),
          referer: document.referrer || location.href,
          url: track.src,
          ...(probe ? { probe } : {}),
        },
        type: "bridge:capture",
      }));
    }
  }
  await Promise.all(pending);
}

async function scan(): Promise<void> {
  const media = captureDomMedia();
  if (window === window.top) {
    const page = scanPageContext();
    const fingerprint = JSON.stringify(page);
    if (fingerprint !== lastPageFingerprint) {
      lastPageFingerprint = fingerprint;
      await send({ page, type: "bridge:page" });
    }
  }
  await media;
}

let lastPageFingerprint = "";
let scanTimer: number | undefined;

function replayCaptures(): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve();
    };
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window || message?.channel !== "qcatch:replay"
        || message.requestId !== requestId || !Array.isArray(message.captures)
        || message.captures.length > 24) return;
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      const captures = (message.captures as unknown[]).map(pageCapture)
        .filter(capture => capture !== undefined);
      void Promise.all(captures.map(payload => send({ payload, type: "bridge:capture" }))).then(finish);
    };
    // Older pages may have no replay-capable MAIN script; DOM discovery still runs.
    const timeout = window.setTimeout(finish, 1000);
    window.addEventListener("message", receive);
    document.dispatchEvent(new CustomEvent("qbutt:start-capture", { detail: requestId }));
  });
}

function scheduleScan(): void {
  if (scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, 400);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object" || window !== window.top) return;
  const update = message as { type?: string };
  if (update.type !== "state:reset" && update.type !== "state:updated") return;
  if (update.type === "state:reset") {
    lastPageFingerprint = "";
    scheduleScan();
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (message && typeof message === "object" && (message as { type?: string }).type === "bridge:refresh") {
    void replayCaptures().then(scan).then(() => sendResponse({ ready: true }));
    return true;
  }
  if (!message || typeof message !== "object" || window !== window.top) return;
  const request = message as {
    episode?: number;
    player?: string;
    selectedSources?: YummySource[];
    sources?: YummyProbeSource[];
    type?: string;
  };
  const handle = async (): Promise<unknown> => {
    if (request.type === "yummy:options") return discoverYummyOptions();
    if (request.type === "yummy:catalog" && request.player) {
      return collectYummyCatalog(request.player, request.selectedSources);
    }
    if (request.type === "yummy:probe" && request.sources && request.episode) {
      await probeYummyEpisode(request.sources, request.episode);
      return { episode: request.episode, ready: true };
    }
    return undefined;
  };
  if (!request.type?.startsWith("yummy:")) return;
  void handle().then(sendResponse).catch((error: unknown) => {
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

function nudgeProbePlayer(): void {
  if (!new URL(location.href).searchParams.has("sc_probe")) return;
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const button = document.querySelector<HTMLElement>(
      ".play_button, .play-button, .vjs-big-play-button, [data-action=play], [aria-label*=Play i], [aria-label*=Воспроизвести i]",
    );
    button?.click();
    const video = document.querySelector<HTMLVideoElement>("video");
    if (video) {
      video.muted = true;
      void video.play().catch(() => undefined);
    }
    if (attempts >= 12) window.clearInterval(timer);
  }, 400);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleScan, { once: true });
else scheduleScan();
preferMaximumAllohaProbeQuality();
listenForAllohaCatalogRequests();
nudgeProbePlayer();
const observationRoot = document.documentElement;
if (observationRoot) {
  new MutationObserver(scheduleScan).observe(observationRoot, { childList: true, subtree: true });
}
