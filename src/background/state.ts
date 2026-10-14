import { parseHlsMaster } from "../shared/hls.ts";
import {
  classifyMedia,
  detectProvider,
  guessContentType,
  isInterestingMedia,
  normalizedHeaders,
  resourceKey,
} from "../shared/media.ts";
import { emptyTabState } from "../shared/types.ts";
import { oneClickService } from "../shared/one-click.ts";
import type { TwitterCapture } from "../shared/twitter-media.ts";
import type { CapturePayload, CapturedResource, PageContext, TabState } from "../shared/types.ts";

const MAX_RESOURCES = 250;
const MEDIA_URL_IN_TEXT = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:m3u8|mpd|mp4|m4a|aac|vtt)(?:\?[^\s"'<>\\]*)?/gi;
const tabMutations = new Map<number, Promise<unknown>>();

async function mutateTab<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = tabMutations.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  tabMutations.set(tabId, current);
  try {
    return await current;
  } finally {
    if (tabMutations.get(tabId) === current) tabMutations.delete(tabId);
  }
}

function stateKey(tabId: number): string {
  return `tab:${tabId}`;
}

type CaptureCandidate = CapturePayload & Pick<CapturedResource, "hlsRendition">;

function identity(payload: CaptureCandidate): string {
  if (payload.hlsRendition) {
    const rendition = payload.hlsRendition;
    return `audio:${resourceKey(payload.url)}:hls:${resourceKey(rendition.masterUrl)}:${rendition.groupId}`;
  }
  if (payload.kind !== "segment") {
    const probe = payload.probe ? `:${payload.probe.episode}:${payload.probe.sourceId}` : "";
    return `${payload.kind}:${resourceKey(payload.url)}${probe}`;
  }
  try {
    const url = new URL(payload.url);
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    return `segment:${payload.provider}:${url.origin}${directory}`;
  } catch {
    return `segment:${payload.provider}:${resourceKey(payload.url)}`;
  }
}

function episodeFromPayload(payload: CapturePayload): number | undefined {
  if (payload.episode !== undefined) return payload.episode;
  if (payload.probe) return payload.probe.episode;
  for (const value of [payload.initiator, payload.referer, payload.url]) {
    if (!value) continue;
    try {
      const episode = Number(new URL(value).searchParams.get("sc_probe") ?? new URL(value).searchParams.get("episode"));
      if (Number.isInteger(episode) && episode > 0) return episode;
    } catch {
      // Ignore incomplete URLs from transient player state.
    }
  }
  return undefined;
}

export async function readTabState(tabId: number): Promise<TabState> {
  const result = await chrome.storage.session.get(stateKey(tabId));
  return (result[stateKey(tabId)] as TabState | undefined) ?? emptyTabState(tabId);
}

async function writeTabState(
  state: TabState,
  messageType: "state:reset" | "state:updated" = "state:updated",
  notifyExtension = false,
): Promise<void> {
  await chrome.storage.session.set({ [stateKey(state.tabId)]: state });
  if (!oneClickService(state.page.url)) {
    const count = state.resources.filter((resource) => ["audio", "dash", "hls", "video"].includes(resource.kind)).length;
    await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6", tabId: state.tabId });
    await chrome.action.setBadgeText({ tabId: state.tabId, text: count > 0 ? String(Math.min(count, 99)) : "" });
  }
  const message = { pageUrl: state.page.url, tabId: state.tabId, type: messageType };
  void chrome.tabs.sendMessage(state.tabId, message).catch(() => undefined);
  if (notifyExtension) void chrome.runtime.sendMessage(message).catch(() => undefined);
}

export async function resetTabState(tabId: number): Promise<void> {
  await mutateTab(tabId, () => writeTabState(emptyTabState(tabId), "state:reset", true));
}

export async function updatePage(tabId: number, page: PageContext): Promise<TabState> {
  return mutateTab(tabId, async () => {
    const state = await readTabState(tabId);
    state.page = page;
    state.revision += 1;
    await writeTabState(state, "state:updated", true);
    return state;
  });
}

export async function updateTwitterCapture(tabId: number, capture: TwitterCapture): Promise<TabState> {
  return mutateTab(tabId, async () => {
    const state = await readTabState(tabId);
    if (JSON.stringify(state.twitter) === JSON.stringify(capture)) return state;
    state.twitter = capture;
    state.revision += 1;
    await writeTabState(state);
    return state;
  });
}

function mergeResource(previous: CapturedResource, next: CapturedResource): CapturedResource {
  const body = next.body || previous.body;
  const contentType = next.contentType || previous.contentType;
  const headers = next.headers ?? previous.headers;
  const initiator = next.initiator || previous.initiator;
  const referer = next.referer || (next.headers === undefined ? previous.referer : undefined);
  const merged: CapturedResource = {
    ...previous,
    ...next,
    ...(body ? { body } : {}),
    ...(contentType ? { contentType } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(initiator ? { initiator } : {}),
  };
  if (referer) merged.referer = referer;
  else delete merged.referer;
  return merged;
}

function extractedResources(payload: CapturePayload): CaptureCandidate[] {
  if (!payload.body) return [];
  if (payload.kind === "hls") {
    const resources: CaptureCandidate[] = [];
    const master = parseHlsMaster(payload.body, payload.url);
    for (const rendition of master.renditions) {
      if (rendition.type !== "audio" || !rendition.url
        || !master.variants.some((variant) => variant.audioGroup === rendition.groupId)) continue;
      resources.push({
        detectedAt: payload.detectedAt,
        default: rendition.default,
        kind: "audio",
        name: rendition.name,
        provider: payload.provider,
        url: rendition.url,
        hlsRendition: {
          masterUrl: payload.url,
          groupId: rendition.groupId,
          ...(rendition.channels ? { channels: rendition.channels } : {}),
        },
        ...(rendition.language ? { language: rendition.language } : {}),
        ...(payload.initiator ? { initiator: payload.initiator } : {}),
      });
    }
    return resources;
  }
  const found = new Set<string>();
  for (const match of payload.body.matchAll(MEDIA_URL_IN_TEXT)) {
    const raw = match[0]?.replaceAll("\\/", "/").replaceAll("\\u0026", "&");
    if (raw) found.add(raw);
  }
  return [...found].map((url) => ({
    detectedAt: payload.detectedAt,
    kind: classifyMedia(url),
    provider: detectProvider(url, payload.initiator),
    url,
    ...(payload.headers?.length ? { headers: payload.headers } : {}),
    ...(payload.initiator ? { initiator: payload.initiator } : {}),
    ...(payload.referer ? { referer: payload.referer } : {}),
  }));
}

export async function addCapture(
  tabId: number,
  frameId: number,
  payload: CapturePayload,
  documentId?: string,
): Promise<TabState> {
  return mutateTab(tabId, async () => {
    const state = await readTabState(tabId);
    const extracted = extractedResources(payload).map((candidate) => {
      if (!candidate.hlsRendition) return candidate;
      const captured = state.resources.find((item) => item.url === candidate.url
        && item.frameId === frameId && item.documentId === documentId);
      if (!captured) return candidate;
      return {
        ...candidate,
        ...(captured.headers ? { headers: captured.headers } : {}),
        ...(captured.referer ? { referer: captured.referer } : {}),
      };
    });
    let changed = false;
    if (payload.kind === "hls" && payload.body) {
      const current = new Set(extracted.filter((item) => item.hlsRendition)
        .map((item) => item.hlsRendition!.groupId + ":" + item.url));
      const renditionUrls = new Set(extracted.map((item) => item.url));
      const retained = state.resources.filter((item) => {
        if (item.frameId !== frameId || item.documentId !== documentId) return true;
        if (item.kind === "hls" && renditionUrls.has(item.url)) return false;
        return item.hlsRendition?.masterUrl !== payload.url
          || current.has(item.hlsRendition.groupId + ":" + item.url);
      });
      changed = retained.length !== state.resources.length;
      state.resources = retained;
    }
    const candidates = [payload, ...extracted].flatMap<CaptureCandidate>((candidate) => {
      if (candidate.kind !== "hls") return [candidate];
      const renditions = state.resources.filter((item) => item.hlsRendition
        && item.url === candidate.url && item.frameId === frameId && item.documentId === documentId);
      return renditions.length > 0 ? renditions.map((item) => ({
        ...candidate,
        kind: "audio" as const,
        ...(item.default !== undefined ? { default: item.default } : {}),
        ...(item.language ? { language: item.language } : {}),
        ...(item.name ? { name: item.name } : {}),
        hlsRendition: item.hlsRendition!,
      })) : [candidate];
    });

    for (const candidate of candidates) {
      if (!isInterestingMedia(candidate.kind)) continue;
      const id = `${frameId}:${documentId ?? ""}:${identity(candidate)}`;
      const episode = episodeFromPayload(candidate);
      const resource: CapturedResource = {
        ...candidate,
        frameId,
        id,
        tabId,
        ...(documentId ? { documentId } : {}),
        ...(episode !== undefined ? { episode } : {}),
      };
      const index = state.resources.findIndex((item) => item.id === id);
      if (index >= 0) {
        const previous = state.resources[index];
        if (!previous || candidate.kind === "segment") continue;
        const merged = mergeResource(previous, resource);
        if (JSON.stringify(merged) !== JSON.stringify(previous)) {
          state.resources[index] = merged;
          changed = true;
        }
      } else {
        state.resources.push(resource);
        changed = true;
      }
    }

    if (!changed) return state;
    state.resources = state.resources
      .sort((left, right) => right.detectedAt - left.detectedAt)
      .slice(0, MAX_RESOURCES);
    state.revision += 1;
    await writeTabState(state);
    return state;
  });
}

export async function addWebRequestCapture(
  details: chrome.webRequest.OnHeadersReceivedDetails,
  requestHeaders: chrome.webRequest.HttpHeader[] = [],
): Promise<void> {
  if (details.tabId < 0) return;
  const contentType = guessContentType(details.responseHeaders ?? []);
  const kind = classifyMedia(details.url, contentType);
  if (!isInterestingMedia(kind)) return;
  const headers = normalizedHeaders(requestHeaders);
  const referer = headers.find((header) => header.name.toLowerCase() === "referer")?.value;
  await addCapture(details.tabId, details.frameId, {
    contentType,
    detectedAt: Date.now(),
    headers,
    kind,
    method: details.method,
    provider: detectProvider(details.url, details.initiator),
    status: details.statusCode,
    url: details.url,
    ...(details.initiator ? { initiator: details.initiator } : {}),
    ...(referer ? { referer } : {}),
  }, details.documentId);
}
