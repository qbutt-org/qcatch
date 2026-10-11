import { buildFilename } from "./filename.ts";
import type {
  CapturedHeader,
  CapturedResource,
  Container,
  DownloadInput,
  DownloadJob,
  DownloadSubtitle,
  Provider,
  TabState,
  YummySource,
} from "./types.ts";

function replayHeaders(
  resource: CapturedResource,
  pageUrl: string,
): CapturedHeader[] {
  const headers = [...(resource.headers ?? [])];
  if (!headers.some((header) => header.name.toLowerCase() === "referer")) {
    headers.push({ name: "Referer", value: resource.referer ?? pageUrl });
  }
  return headers;
}

export function resourceScore(resource: CapturedResource): number {
  const heights = [
    ...resource.url.matchAll(
      /(?:^|[/_.-])(2160|1440|1080|720|576|480|360)(?:p|[/_.-]|$)/gi,
    ),
    ...(resource.body?.matchAll(/(?:RESOLUTION=\d+x|\bheight=["'])(\d+)/gi) ??
      []),
  ].map((match) => Number(match[1] ?? 0));
  const height = Math.max(0, ...heights);
  let sourceRank =
    resource.kind === "dash"
      ? 400
      : resource.kind === "hls"
        ? 350
        : resource.kind === "video"
          ? 250
          : 0;
  if (resource.body?.includes("#EXT-X-STREAM-INF")) sourceRank += 120;
  if (resource.body?.includes("<MPD")) sourceRank += 100;
  return height * 10_000 + sourceRank;
}

export function compareResources(
  left: CapturedResource,
  right: CapturedResource,
): number {
  return (
    resourceScore(right) - resourceScore(left) ||
    right.detectedAt - left.detectedAt
  );
}

export function bestResource(
  resources: readonly CapturedResource[],
  provider?: Provider,
): CapturedResource | undefined {
  return resources
    .filter((resource) =>
      ["dash", "hls", "video", "audio"].includes(resource.kind),
    )
    .filter(
      (resource) =>
        !provider || provider === "unknown" || resource.provider === provider,
    )
    .sort(compareResources)[0];
}

function downloadInput(
  resource: CapturedResource,
  pageUrl: string,
  overrides: Partial<Pick<DownloadInput, "name" | "role">> = {},
): DownloadInput {
  if (!["audio", "dash", "hls", "video"].includes(resource.kind)) {
    throw new Error("Ресурс не является входной медиадорожкой");
  }
  const kind = resource.kind as DownloadInput["kind"];
  return {
    headers: replayHeaders(resource, pageUrl),
    kind,
    role: overrides.role ?? (kind === "audio" ? "audio" : "media"),
    url: resource.url,
    ...(overrides.name || resource.name
      ? { name: overrides.name ?? resource.name }
      : {}),
  };
}

function subtitleName(resource: CapturedResource): string {
  if (resource.name) return resource.name;
  try {
    return decodeURIComponent(
      new URL(resource.url).pathname.split("/").pop() ?? "Субтитры",
    ).replace(/\.(?:vtt|srt|ass)$/i, "");
  } catch {
    return "Субтитры";
  }
}

function downloadSubtitle(
  resource: CapturedResource,
  pageUrl: string,
): DownloadSubtitle {
  const label = subtitleName(resource);
  const inferredLanguage = /(?:^|[\s([])(?:russian|русск)/i.test(label)
    ? "rus"
    : /(?:^|[\s([])(?:japanese|японск)/i.test(label)
      ? "jpn"
      : "und";
  return {
    default: resource.default ?? false,
    forced: resource.forced ?? false,
    headers: replayHeaders(resource, pageUrl),
    language:
      resource.language && resource.language !== "und"
        ? resource.language
        : inferredLanguage,
    name: label,
    url: resource.url,
  };
}

export function buildDownloadJob(options: {
  additionalInputs?: Array<{
    name?: string;
    resource: CapturedResource;
    role: DownloadInput["role"];
  }>;
  audio?: CapturedResource[];
  container: Container;
  createdAt?: number;
  episode?: number;
  id?: string;
  pageUrl: string;
  player?: string;
  source: CapturedResource;
  sourceName?: string;
  subtitles?: CapturedResource[];
  tabId: number;
  title: string;
  yummySources?: YummySource[];
}): DownloadJob {
  const extension =
    options.source.kind === "audio" && options.container === "mp4"
      ? "m4a"
      : options.container;
  const inputs = [
    downloadInput(
      options.source,
      options.pageUrl,
      options.sourceName ? { name: options.sourceName } : {},
    ),
  ];
  for (const input of options.additionalInputs ?? []) {
    inputs.push(
      downloadInput(input.resource, options.pageUrl, {
        role: input.role,
        ...(input.name ? { name: input.name } : {}),
      }),
    );
  }
  for (const audio of options.audio ?? [])
    inputs.push(downloadInput(audio, options.pageUrl));
  return {
    container: options.container,
    createdAt: options.createdAt ?? Date.now(),
    filename: buildFilename(options.title, extension, options.episode),
    id: options.id ?? crypto.randomUUID(),
    inputs,
    pageUrl: options.pageUrl,
    subtitles: (options.subtitles ?? []).map((resource) =>
      downloadSubtitle(resource, options.pageUrl),
    ),
    tabId: options.tabId,
    title: options.title,
    ...(options.episode !== undefined ? { episode: options.episode } : {}),
    ...(options.player ? { player: options.player } : {}),
    ...(options.yummySources?.length
      ? { yummySources: options.yummySources }
      : {}),
  };
}

export function planYummyJobs(request: {
  container: Container;
  episodes: number[];
  pageUrl: string;
  player: string;
  tabId: number;
  title: string;
  yummySources: YummySource[];
}): DownloadJob[] {
  const createdAt = Date.now();
  return request.episodes.map((episode) => ({
    container: request.container,
    createdAt,
    episode,
    filename: buildFilename(request.title, request.container, episode),
    id: crypto.randomUUID(),
    inputs: [],
    pageUrl: request.pageUrl,
    player: request.player,
    subtitles: [],
    tabId: request.tabId,
    title: request.title,
    yummySources: request.yummySources,
  }));
}

export function buildCurrentJob(
  state: TabState,
  sourceId: string,
  audioIds: readonly string[],
  subtitleIds: readonly string[],
  container: Container,
): DownloadJob {
  const source = state.resources.find((resource) => resource.id === sourceId);
  if (!source) throw new Error("Выбранный поток больше не доступен");
  return buildDownloadJob({
    audio: state.resources.filter(
      (resource) =>
        audioIds.includes(resource.id) &&
        resource.id !== sourceId &&
        resource.kind === "audio",
    ),
    container,
    pageUrl: state.page.url,
    source,
    subtitles: state.resources.filter(
      (resource) =>
        subtitleIds.includes(resource.id) && resource.kind === "subtitle",
    ),
    tabId: state.tabId,
    title: state.page.title,
    ...(state.page.yummy ? { episode: state.page.yummy.episode } : {}),
  });
}

export function providerFromName(value: string): Provider {
  if (/alloha/i.test(value)) return "alloha";
  if (/kodik/i.test(value)) return "kodik";
  if (/cvh|cdnvideo/i.test(value)) return "cdnvideohub";
  return "unknown";
}
