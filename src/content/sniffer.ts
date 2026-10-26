import {
  classifyMedia,
  detectProvider,
  isInterestingMedia,
  normalizedHeaders,
  scopedHeaders,
} from "../shared/media.ts";
import { extractTwitterCapture } from "../shared/twitter-media.ts";
import { extractTikTokPhotos } from "../shared/tiktok-photos.ts";
import type { CapturedHeader, CapturePayload } from "../shared/types.ts";

const CAPTURE_CHANNEL = "qcatch:capture";
const TWITTER_CHANNEL = "qcatch:twitter";
const MAX_TEXT_LENGTH = 4 * 1024 * 1024;
const originalFetch = window.fetch;
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
const requestUrls = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers }>();
const recentCaptures = new Map<string, CapturePayload>();

function httpUrl(value: string | URL): string | undefined {
  try {
    const url = new URL(String(value), location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function post(payload: CapturePayload, headers?: CapturedHeader[]): void {
  if (payload.kind !== "segment") {
    const previous = recentCaptures.get(payload.url);
    // Response metadata starts a new body; URL-only observations do not.
    const body = payload.body ?? (payload.status === undefined ? previous?.body ?? "" : "");
    recentCaptures.delete(payload.url);
    recentCaptures.set(payload.url, { ...previous, ...payload, body, ...(headers ? { headers } : {}) });
    while (recentCaptures.size > 24
      || [...recentCaptures.values()].reduce((size, capture) => size + (capture.body?.length ?? 0), 0) > MAX_TEXT_LENGTH) {
      recentCaptures.delete(recentCaptures.keys().next().value!);
    }
  }
  // Live capture gets complete headers from webRequest. Replay retains page-provided headers.
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

function isTikTokItemResponse(value: string): boolean {
  return location.hostname === "www.tiktok.com"
    && value.startsWith(`${location.origin}/api/item/detail/?`);
}

function captureTikTokPhotos(body: string): void {
  const capture = extractTikTokPhotos(body, location.href);
  if (capture) window.postMessage({ capture, channel: "qcatch:tiktok-photos" }, "*");
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
    headers?: CapturedHeader[];
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
  }, options.headers);
}

async function captureFetchResponse(
  response: Response,
  method: string,
  requestUrl: string,
  headers: CapturedHeader[],
): Promise<void> {
  const url = response.url;
  const contentType = response.headers.get("content-type") ?? "";
  capture(url, { contentType, method, status: response.status, requestUrl, headers });

  const length = Number(response.headers.get("content-length") ?? 0);
  const kind = classifyMedia(url, contentType);
  const twitterResponse = isTwitterTweetResponse(url);
  const tiktokResponse = isTikTokItemResponse(url);
  const textResponse = kind === "hls" || kind === "dash" || isProviderApi(url) || twitterResponse || tiktokResponse;
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
      else if (tiktokResponse) captureTikTokPhotos(body);
      else capture(url, { body, contentType, method, status: response.status, requestUrl, headers });
    }
  } catch {
    // Binary and locked response bodies are still captured by URL and headers.
  }
}

const interceptedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const headers = normalizedHeaders([...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))]
    .map(([name, value]) => ({ name, value })));
  const response = await Reflect.apply(originalFetch, window, [input, init]);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), document.baseURI).href;
  void captureFetchResponse(response, method, requestUrl, scopedHeaders(headers, requestUrl, response.url || requestUrl));
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
  if (resolvedUrl) requestUrls.set(this, { method, url: resolvedUrl, headers: new Headers() });
  else requestUrls.delete(this);
};

XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name: string, value: string): void {
  originalSetRequestHeader.call(this, name, value);
  requestUrls.get(this)?.headers.append(name, value);
};

XMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
  this.addEventListener("loadend", () => {
    const request = requestUrls.get(this);
    if (!request) return;
    const contentType = this.getResponseHeader("content-type") ?? "";
    const kind = classifyMedia(request.url, contentType);
    const twitterResponse = isTwitterTweetResponse(request.url);
    if (isTikTokItemResponse(request.url)) {
      try {
        const body = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
        if (body.length <= MAX_TEXT_LENGTH) captureTikTokPhotos(body);
      } catch {
        // A response body may be unavailable to the page.
      }
      return;
    }
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
      headers: scopedHeaders(
        normalizedHeaders([...request.headers].map(([name, value]) => ({ name, value }))),
        request.url,
        finalUrl,
      ),
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

document.addEventListener("DOMContentLoaded", () => {
  scheduleMediaScan();
  const body = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent;
  if (body && body.length <= MAX_TEXT_LENGTH) captureTikTokPhotos(body);
}, { once: true });
document.addEventListener("qbutt:start-capture", event => {
  const requestId = (event as CustomEvent<unknown>).detail;
  const captures = [...recentCaptures.values()].filter(capture => capture.initiator === location.href);
  if (typeof requestId === "string") {
    window.postMessage({ channel: "qcatch:replay", requestId, captures }, "*");
    return;
  }
  for (const payload of captures) {
    window.postMessage({ channel: CAPTURE_CHANNEL, payload }, "*");
  }
  scanMediaElements();
});
const mediaObservationRoot = document.documentElement;
if (mediaObservationRoot) {
  new MutationObserver(scheduleMediaScan).observe(mediaObservationRoot, { childList: true, subtree: true });
}
