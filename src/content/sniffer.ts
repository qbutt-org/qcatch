import { classifyMedia, detectProvider, isInterestingMedia } from "../shared/media.ts";
import { extractTwitterCapture } from "../shared/twitter-media.ts";
import type { CapturePayload } from "../shared/types.ts";

const CAPTURE_CHANNEL = "qcatch:capture";
const TWITTER_CHANNEL = "qcatch:twitter";
const MAX_TEXT_LENGTH = 4 * 1024 * 1024;
const originalFetch = window.fetch;
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const requestUrls = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
const probeCaptures = new Map<string, CapturePayload>();

function httpUrl(value: string | URL): string | undefined {
  try {
    const url = new URL(String(value), location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function post(payload: CapturePayload): void {
  if (window.name === "qbutt:player") {
    const previous = probeCaptures.get(payload.url);
    if (probeCaptures.size < 24 || previous) {
      // Response metadata starts a new body; URL-only observations do not.
      const body = payload.body ?? (payload.status === undefined ? previous?.body ?? "" : "");
      probeCaptures.set(payload.url, { ...previous, ...payload, body });
    }
  }
  window.postMessage({ channel: CAPTURE_CHANNEL, payload }, "*");
}

function isTwitterTweetResponse(url: string): boolean {
  let responseUrl: URL;
  try {
    responseUrl = new URL(url);
  } catch {
    return false;
  }
  return ["x.com", "twitter.com"].includes(responseUrl.hostname)
    && /\/i\/api\/graphql\/[^/]+\/(?:TweetDetail|TweetResultByRestId)$/.test(responseUrl.pathname);
}

function captureTwitterResponse(value: unknown): void {
  const capture = extractTwitterCapture(value, location.href);
  if (capture) window.postMessage({ capture, channel: TWITTER_CHANNEL }, "*");
}

function isProviderApi(url: string): boolean {
  return detectProvider(url, location.href) !== "unknown"
    && /(?:\/ftor\b|\/playlist\b|\/video\/|manifest|source)/i.test(url);
}

function capture(
  url: string,
  options: {
    body?: string;
    contentType?: string;
    method?: string;
    status?: number;
    requestUrl?: string;
  } = {},
): void {
  if (!/^https?:/i.test(url)) return;
  const body = options.body ?? "";
  const kind = classifyMedia(url, options.contentType, body);
  const provider = detectProvider(url, location.href);
  if (!isInterestingMedia(kind) && !isProviderApi(url)) return;

  post({
    detectedAt: Date.now(),
    initiator: location.href,
    kind,
    provider,
    referer: document.referrer || location.href,
    url,
    ...(body ? { body } : {}),
    ...(options.contentType ? { contentType: options.contentType } : {}),
    ...(options.method ? { method: options.method } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.requestUrl ? { requestUrl: options.requestUrl } : {}),
  });
}

async function captureFetchResponse(response: Response, method: string, requestUrl: string): Promise<void> {
  const url = response.url;
  const contentType = response.headers.get("content-type") ?? "";
  capture(url, { contentType, method, status: response.status, requestUrl });

  const length = Number(response.headers.get("content-length") ?? 0);
  const kind = classifyMedia(url, contentType);
  const twitterResponse = isTwitterTweetResponse(url);
  const textResponse = kind === "hls" || kind === "dash" || isProviderApi(url) || twitterResponse;
  if (!textResponse || length > MAX_TEXT_LENGTH) return;

  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          body += decoder.decode();
          break;
        }
        size += chunk.value.byteLength;
        if (size > MAX_TEXT_LENGTH) return;
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (body.length <= MAX_TEXT_LENGTH) {
      if (twitterResponse) captureTwitterResponse(body);
      else capture(url, { body, contentType, method, status: response.status, requestUrl });
    }
  } catch {
    // Binary and locked response bodies are still captured by URL and headers.
  }
}

const interceptedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await Reflect.apply(originalFetch, window, [input, init]);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), document.baseURI).href;
  void captureFetchResponse(response, method, requestUrl);
  return response;
};
Object.assign(interceptedFetch, originalFetch);
window.fetch = interceptedFetch as typeof window.fetch;

XMLHttpRequest.prototype.open = function open(
  method: string,
  url: string | URL,
  async = true,
  username?: string | null,
  password?: string | null,
): void {
  Reflect.apply(originalOpen, this, [method, url, async, username, password]);
  const resolvedUrl = httpUrl(url);
  if (resolvedUrl) requestUrls.set(this, { method, url: resolvedUrl });
  else requestUrls.delete(this);
};

XMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
  this.addEventListener("loadend", () => {
    const request = requestUrls.get(this);
    if (!request) return;
    const contentType = this.getResponseHeader("content-type") ?? "";
    const kind = classifyMedia(request.url, contentType);
    const twitterResponse = isTwitterTweetResponse(request.url);
    if (twitterResponse) {
      try {
        const response = this.responseType === "json" ? this.response : this.responseText;
        if (typeof response !== "string" || response.length <= MAX_TEXT_LENGTH) captureTwitterResponse(response);
      } catch {
        // Cross-origin XHR can expose metadata while blocking its response body.
      }
      return;
    }

    let responseBody = "";
    if (kind === "hls" || kind === "dash" || isProviderApi(request.url)) {
      try {
        if (this.responseType === "" || this.responseType === "text") responseBody = this.responseText;
        if (this.responseType === "json") responseBody = JSON.stringify(this.response);
      } catch {
        // Cross-origin XHR can expose metadata while blocking its response body.
      }
    }
    const finalUrl = this.responseURL || request.url;
    capture(finalUrl, {
      contentType,
      method: request.method,
      status: this.status,
      requestUrl: request.url,
      ...(responseBody.length <= MAX_TEXT_LENGTH ? { body: responseBody } : {}),
    });
  }, { once: true });
  originalSend.call(this, body);
};

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) capture(entry.name);
}).observe({ entryTypes: ["resource"] });

function scanMediaElements(): void {
  for (const element of document.querySelectorAll<HTMLMediaElement>("audio,video")) {
    if (element.currentSrc) capture(element.currentSrc);
    if (element.src) capture(element.src);
    for (const source of element.querySelectorAll<HTMLSourceElement>("source[src]")) capture(source.src);
    for (const track of element.querySelectorAll<HTMLTrackElement>("track[src]")) {
      capture(track.src, { contentType: "text/vtt" });
    }
  }
}

let mediaScanTimer: number | undefined;
function scheduleMediaScan(): void {
  if (mediaScanTimer !== undefined) return;
  mediaScanTimer = window.setTimeout(() => {
    mediaScanTimer = undefined;
    scanMediaElements();
  }, 250);
}

document.addEventListener("DOMContentLoaded", scheduleMediaScan, { once: true });
document.addEventListener("qbutt:start-capture", () => {
  for (const payload of probeCaptures.values()) {
    window.postMessage({ channel: CAPTURE_CHANNEL, payload }, "*");
  }
  probeCaptures.clear();
  scanMediaElements();
});
const mediaObservationRoot = document.documentElement;
if (mediaObservationRoot) {
  new MutationObserver(scheduleMediaScan).observe(mediaObservationRoot, { childList: true, subtree: true });
}
