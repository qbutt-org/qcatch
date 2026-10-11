import { parseIsoDuration } from "../shared/dash.ts";
import { bestHlsVariant, parseHlsMaster } from "../shared/hls.ts";
import { bestResource, buildDownloadJob, providerFromName } from "../shared/jobs.ts";
import type { CapturedResource, DownloadJob, PreparedYummyBatchRequest, YummyBatchRequest, YummyCatalog, YummyEstimate } from "../shared/types.ts";
import { yummySourceKey } from "../shared/yummy.ts";
import { sendYummyMessage } from "./content.ts";
import { queueItemIsActive, replaceQueueJob } from "./queue.ts";
import { readTabState } from "./state.ts";

const tabOperations = new Map<number, Promise<void>>();
const estimateGenerations = new Map<number, number>();

export function invalidateYummyEstimates(tabId: number): void {
  estimateGenerations.set(tabId, (estimateGenerations.get(tabId) ?? 0) + 1);
}

export async function withYummyTabLock<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = tabOperations.get(tabId) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  tabOperations.set(tabId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tabOperations.get(tabId) === tail) tabOperations.delete(tabId);
  }
}

export function prepareYummyJob(
  request: PreparedYummyBatchRequest,
  planned: DownloadJob,
): Promise<DownloadJob | undefined> {
  return withYummyTabLock(request.tabId, () => prepareYummyJobUnlocked(request, planned));
}

async function prepareYummyJobUnlocked(
  request: PreparedYummyBatchRequest,
  planned: DownloadJob,
): Promise<DownloadJob | undefined> {
  if (planned.episode === undefined || !await queueItemIsActive(planned.id)) return undefined;
  const initialState = await readTabState(request.tabId);
  if (initialState.page.url !== request.pageUrl) {
    throw new Error("Исходная страница аниме изменилась. Вернитесь на неё и запустите загрузку заново.");
  }

  const startedAt = Date.now();
  const response = await sendYummyMessage<{ error?: string }>(request.tabId, {
    episode: planned.episode,
    sources: request.sources,
    type: "yummy:probe",
  });
  if (response?.error) throw new Error(response.error);
  if (!await queueItemIsActive(planned.id)) return undefined;

  const state = await readTabState(request.tabId);
  if (state.page.url !== request.pageUrl) {
    throw new Error("Исходная страница аниме изменилась. Вернитесь на неё и запустите загрузку заново.");
  }
  const provider = providerFromName(request.context.player);
  const fresh = state.resources.filter((resource) =>
    resource.detectedAt >= startedAt - 500
    && (resource.episode === undefined || resource.episode === planned.episode),
  );
  const tagged = fresh.filter((resource) => sourceProbeId(resource) !== undefined)
    .filter((resource) => provider === "unknown" || resource.provider === provider);
  const available = request.sources.flatMap((source) => {
    const resources = tagged.filter((resource) => sourceProbeId(resource) === source.probeId);
    const media = bestResource(resources, provider);
    return media ? [{ media, source }] : [];
  });
  const primary = bestResource(available.map(({ media }) => media), provider);
  if (!primary) throw new Error(`Плеер ${request.context.player} не отдал ни одного доступного потока`);
  const primaryEntry = available.find(({ media }) => media.id === primary.id && media.url === primary.url);
  if (!primaryEntry) throw new Error("Не удалось определить основной поток серии");

  const usedUrls = new Set([primary.url]);
  const additionalInputs = available.flatMap(({ media, source }) => {
    if (usedUrls.has(media.url)) return [];
    usedUrls.add(media.url);
    return [{ name: source.name, resource: media, role: "audio" as const }];
  });
  for (const resource of tagged.filter((item) => item.kind === "audio")) {
    if (usedUrls.has(resource.url)) continue;
    usedUrls.add(resource.url);
    const source = request.sources.find((candidate) => candidate.probeId === sourceProbeId(resource));
    if (source) additionalInputs.push({ name: source.name, resource, role: "audio" });
  }

  const subtitles = request.sources.flatMap((source) => tagged
    .filter((resource) => resource.kind === "subtitle" && sourceProbeId(resource) === source.probeId)
    .map((resource) => ({
      ...resource,
      name: [source.name, resource.name].filter(Boolean).join(" / "),
    })));
  const successfulSources = available.map(({ source }) => ({ kind: source.kind, name: source.name }));
  const job = buildDownloadJob({
    additionalInputs,
    container: planned.container,
    createdAt: planned.createdAt,
    episode: planned.episode,
    id: planned.id,
    pageUrl: state.page.url,
    source: primary,
    sourceName: primaryEntry.source.name,
    subtitles,
    tabId: request.tabId,
    title: request.context.title,
    ...(planned.player ? { player: planned.player } : {}),
    yummySources: successfulSources,
  });
  if (!await queueItemIsActive(planned.id)) return undefined;
  await replaceQueueJob(planned.id, job);
  return job;
}

function headersFor(resource: CapturedResource, pageUrl: string): Headers {
  const headers = new Headers();
  for (const header of resource.headers ?? []) headers.set(header.name, header.value);
  if (!headers.has("referer")) headers.set("referer", resource.referer ?? pageUrl);
  return headers;
}

async function manifestText(resource: CapturedResource, pageUrl: string): Promise<string> {
  if (resource.body) return resource.body;
  const response = await fetch(resource.url, { headers: headersFor(resource, pageUrl) });
  if (!response.ok) throw new Error(`Сервер вернул ${response.status}`);
  return response.text();
}

function hlsEntries(body: string, baseUrl: string): Array<{ duration: number; url: string }> {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const entries: Array<{ duration: number; url: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^#EXTINF:([\d.]+)/);
    if (!match) continue;
    const next = lines.slice(index + 1).find((line) => line && !line.startsWith("#"));
    const duration = Number(match[1]);
    if (next && Number.isFinite(duration) && duration > 0) entries.push({ duration, url: new URL(next, baseUrl).href });
  }
  return entries;
}

async function contentLength(url: string, headers: Headers): Promise<number | undefined> {
  const response = await fetch(url, { headers, method: "HEAD" });
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

async function estimateHls(resource: CapturedResource, pageUrl: string): Promise<number | undefined> {
  const masterBody = await manifestText(resource, pageUrl);
  const master = parseHlsMaster(masterBody, resource.url);
  const variant = bestHlsVariant(master.variants);
  const playlistUrl = variant?.url ?? resource.url;
  const playlistResponse = variant ? await fetch(playlistUrl, { headers: headersFor(resource, pageUrl) }) : undefined;
  if (playlistResponse && !playlistResponse.ok) throw new Error(`Сервер вернул ${playlistResponse.status}`);
  const playlist = playlistResponse ? await playlistResponse.text() : masterBody;
  const entries = hlsEntries(playlist, playlistUrl);
  const duration = entries.reduce((total, entry) => total + entry.duration, 0);
  if (variant?.bandwidth && duration > 0) return variant.bandwidth * duration / 8;
  const first = entries[0];
  if (!first || duration <= 0) return undefined;
  const bytes = await contentLength(first.url, headersFor(resource, pageUrl));
  return bytes ? bytes * duration / first.duration : undefined;
}

function estimateDash(body: string): number | undefined {
  const duration = parseIsoDuration(body.match(/<MPD\b[^>]*\bmediaPresentationDuration=["']([^"']+)/i)?.[1] ?? null);
  const bandwidths = [...body.matchAll(/<Representation\b[^>]*\bbandwidth=["'](\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter((bandwidth) => Number.isFinite(bandwidth) && bandwidth > 0);
  const bandwidth = Math.max(...bandwidths, 0);
  return duration > 0 && bandwidth > 0 ? bandwidth * duration / 8 : undefined;
}

async function estimateResource(resource: CapturedResource, pageUrl: string): Promise<number | undefined> {
  if (resource.kind === "hls") return estimateHls(resource, pageUrl);
  if (resource.kind === "dash") return estimateDash(await manifestText(resource, pageUrl));
  return contentLength(resource.url, headersFor(resource, pageUrl));
}

export function estimateYummyBatch(request: YummyBatchRequest): Promise<YummyEstimate> {
  const generation = (estimateGenerations.get(request.tabId) ?? 0) + 1;
  estimateGenerations.set(request.tabId, generation);
  return withYummyTabLock(request.tabId, () => generation === estimateGenerations.get(request.tabId)
    ? estimateYummyBatchUnlocked(request)
    : Promise.resolve({ tracks: [] }));
}

async function estimateYummyBatchUnlocked(request: YummyBatchRequest): Promise<YummyEstimate> {
  const initialState = await readTabState(request.tabId);
  if (initialState.page.url !== request.pageUrl) {
    throw new Error("Страница аниме изменилась. Откройте popup заново, чтобы обновить дорожки.");
  }
  const startedAt = Date.now();
  const catalog = await sendYummyMessage<YummyCatalog & { error?: string }>(request.tabId, {
    player: request.context.player,
    selectedSources: request.selectedSources,
    type: "yummy:catalog",
  });
  if (catalog.error) throw new Error(catalog.error);
  const episode = request.episodes[0];
  if (episode === undefined) throw new Error("Выберите хотя бы одну серию");
  await sendYummyMessage(request.tabId, { episode, sources: catalog.sources, type: "yummy:probe" });

  const state = await readTabState(request.tabId);
  if (state.page.url !== request.pageUrl) {
    throw new Error("Страница аниме изменилась. Откройте popup заново, чтобы обновить дорожки.");
  }
  const provider = providerFromName(request.context.player);
  const fresh = state.resources.filter((resource) =>
    resource.detectedAt >= startedAt - 500
    && (resource.episode === undefined || resource.episode === episode)
    && (provider === "unknown" || resource.provider === provider),
  );
  const measuredUrls = new Set<string>();
  const tracks = await Promise.all(catalog.sources.map(async (source) => {
    const candidates = fresh.filter((candidate) => sourceProbeId(candidate) === source.probeId);
    const resource = source.kind === "subtitle"
      ? candidates.filter((candidate) => candidate.kind === "subtitle").sort((left, right) => right.detectedAt - left.detectedAt)[0]
      : bestResource(candidates, provider);
    if (!resource || measuredUrls.has(resource.url)) return { key: yummySourceKey(source) };
    measuredUrls.add(resource.url);
    try {
      const bytes = await estimateResource(resource, state.page.url);
      return { key: yummySourceKey(source), ...(bytes ? { bytes: bytes * request.episodes.length } : {}) };
    } catch {
      return { key: yummySourceKey(source) };
    }
  }));
  return { tracks };
}

function sourceProbeId(resource: CapturedResource): string | undefined {
  if (resource.probe) return resource.probe.sourceId;
  for (const value of [resource.initiator, resource.referer, resource.url]) {
    if (!value) continue;
    try {
      const probeId = new URL(value).searchParams.get("sc_source");
      if (probeId !== null) return probeId;
    } catch {
      // Ignore transient player URLs.
    }
  }
  return undefined;
}
