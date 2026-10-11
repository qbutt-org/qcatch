import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  HLS_FORMATS,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  TextSubtitleSource,
  UrlSource,
} from "mediabunny";
import type { InputAudioTrack, InputTrack, InputVideoTrack, StreamTargetChunk } from "mediabunny";
import { dashToHls, parseDashManifest } from "../shared/dash.ts";
import { bestHlsVariant, hlsIsEncrypted, parseHlsMaster } from "../shared/hls.ts";
import type { CapturedHeader, DownloadInput, DownloadJob, DownloadSubtitle } from "../shared/types.ts";

const WORK_DIRECTORY = "qcatch";

type PreparedInput = {
  cleanup?: () => Promise<void> | void;
  input: Input;
  name?: string;
  role: DownloadInput["role"];
};

type AudioTrackInfo = {
  language: string;
  name: string;
  track: InputAudioTrack;
};

function requestHeaders(headers: CapturedHeader[]): Headers {
  const result = new Headers();
  for (const header of headers) {
    if (/^(?:origin|referer)$/i.test(header.name)) continue;
    result.set(header.name, header.value);
  }
  return result;
}

async function checkedFetch(url: string, source: { url: string; headers: CapturedHeader[] }, init: RequestInit = {}): Promise<Response> {
  const sameOrigin = new URL(url).origin === new URL(source.url).origin;
  const mergedHeaders = requestHeaders(source.headers.filter((header) => sameOrigin || /^(?:accept|range)$/i.test(header.name)));
  new Headers(init.headers).forEach((value, name) => mergedHeaders.set(name, value));
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: mergedHeaders,
    redirect: source.headers.some((header) => /^(?:authorization|authorizations|x-)/i.test(header.name)) ? "error" : "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} при загрузке ${new URL(url).hostname}`);
  return response;
}

type HlsSegment = {
  byteRange?: { length: number; offset: number };
  url: string;
};

function hlsByteRange(value: string, previousEnd: number): { length: number; offset: number } | undefined {
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match?.[1]) return undefined;
  return { length: Number(match[1]), offset: match[2] ? Number(match[2]) : previousEnd };
}

function hlsMap(line: string, baseUrl: string): HlsSegment | undefined {
  const uri = line.match(/(?:^|,)URI="([^"]+)"/i)?.[1];
  if (!uri) return undefined;
  const range = line.match(/(?:^|,)BYTERANGE="([^"]+)"/i)?.[1];
  const byteRange = range ? hlsByteRange(range, 0) : undefined;
  return {
    url: new URL(uri, baseUrl).href,
    ...(byteRange ? { byteRange } : {}),
  };
}

function hlsSegments(body: string, baseUrl: string): { init?: HlsSegment; segments: HlsSegment[] } {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const segments: HlsSegment[] = [];
  let byteRange: { length: number; offset: number } | undefined;
  let previousEnd = 0;
  let init: HlsSegment | undefined;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      init = hlsMap(line.slice(line.indexOf(":") + 1), baseUrl);
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      byteRange = hlsByteRange(line.slice(line.indexOf(":") + 1), previousEnd);
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    segments.push({
      url: new URL(line, baseUrl).href,
      ...(byteRange ? { byteRange } : {}),
    });
    if (byteRange) previousEnd = byteRange.offset + byteRange.length;
    else previousEnd = 0;
    byteRange = undefined;
  }
  return { ...(init ? { init } : {}), segments };
}

async function mediaPlaylist(source: DownloadInput, signal: AbortSignal): Promise<{ body: string; url: string }> {
  let url = source.url;
  for (let depth = 0; depth < 4; depth += 1) {
    const body = await (await checkedFetch(url, source, { signal })).text();
    if (hlsIsEncrypted(body)) throw new Error("Этот HLS-поток зашифрован и не поддерживается");
    const master = parseHlsMaster(body, url);
    if (master.variants.length === 0) return { body, url };
    const variants = source.role === "audio"
      ? [...master.variants].sort((left, right) =>
        (left.width ?? 0) * (left.height ?? 0) - (right.width ?? 0) * (right.height ?? 0)
        || left.bandwidth - right.bandwidth)
      : master.variants;
    const variant = source.role === "audio" ? variants[0] : bestHlsVariant(variants);
    if (!variant) break;
    const rendition = source.role === "audio" && variant.audioGroup
      ? master.renditions.find((candidate) =>
        candidate.type === "audio" && candidate.groupId === variant.audioGroup && candidate.default && candidate.url)
        ?? master.renditions.find((candidate) =>
          candidate.type === "audio" && candidate.groupId === variant.audioGroup && candidate.url)
      : undefined;
    url = rendition?.url ?? variant.url;
  }
  throw new Error("HLS-плейлист содержит слишком много уровней вложенности");
}

async function writeResponse(
  writable: FileSystemWritableFileStream,
  segment: HlsSegment,
  source: DownloadInput,
  signal: AbortSignal,
): Promise<void> {
  const requestHeaders = segment.byteRange
    ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
    : undefined;
  const response = await checkedFetch(segment.url, source, { signal, ...(requestHeaders ? { headers: requestHeaders } : {}) });
  if (!response.body) throw new Error(`Сервер ${new URL(segment.url).hostname} вернул пустой сегмент`);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await writable.write(value);
  }
}

async function stageHlsInput(
  source: DownloadInput,
  directory: FileSystemDirectoryHandle,
  name: string,
  signal: AbortSignal,
  onProgress: (value: number) => void,
): Promise<PreparedInput> {
  const playlist = await mediaPlaylist(source, signal);
  const media = hlsSegments(playlist.body, playlist.url);
  if (media.segments.length === 0) throw new Error("HLS-плейлист не содержит медиасегментов");
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    if (media.init) await writeResponse(writable, media.init, source, signal);
    for (let index = 0; index < media.segments.length; index += 1) {
      if (signal.aborted) throw new Error("Загрузка отменена");
      await writeResponse(writable, media.segments[index]!, source, signal);
      onProgress((index + 1) / media.segments.length);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
  const file = await handle.getFile();
  return {
    input: new Input({ formats: ALL_FORMATS, source: new BlobSource(file) }),
    role: source.role,
    ...(source.name ? { name: source.name } : {}),
    cleanup: () => directory.removeEntry(name).catch(() => undefined),
  };
}

async function prepareInput(source: DownloadInput, signal: AbortSignal): Promise<PreparedInput> {
  let url = source.url;
  let cleanup: (() => void) | undefined;
  let hls = false;

  if (source.kind === "dash") {
    const manifest = await (await checkedFetch(source.url, source, { signal })).text();
    const synthetic = dashToHls(parseDashManifest(manifest, source.url));
    url = synthetic.url;
    cleanup = synthetic.cleanup;
    hls = true;
  }

  const input = new Input({
    formats: hls ? HLS_FORMATS : ALL_FORMATS,
    source: new UrlSource(url, {
      maxCacheSize: (source.role === "audio" ? 4 : 16) * 1024 * 1024,
      parallelism: source.role === "audio" ? 1 : 3,
      requestInit: {
        credentials: "include",
      },
      fetchFn: (async (input, init) => {
        const requestedUrl = input instanceof Request ? input.url : String(input);
        const response = await checkedFetch(requestedUrl, source, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        });
        const url = response.url;
        const contentType = response.headers.get("content-type") ?? "";
        if (/\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(contentType)) {
          const body = await response.clone().text();
          if (hlsIsEncrypted(body)) throw new Error("Этот HLS-поток зашифрован и не поддерживается");
        }
        return response;
      }) as typeof fetch,
    }),
  });
  return {
    input,
    role: source.role,
    ...(source.name ? { name: source.name } : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}

async function bestVideoTrack(tracks: InputVideoTrack[]): Promise<InputVideoTrack | undefined> {
  const scored = await Promise.all(tracks.map(async (track) => ({
    bitrate: await track.getBitrate() ?? 0,
    pixels: await track.getDisplayWidth() * await track.getDisplayHeight(),
    track,
  })));
  return scored.sort((left, right) => right.pixels - left.pixels || right.bitrate - left.bitrate)[0]?.track;
}

function languageCode(language: string): string {
  const known: Record<string, string> = {
    en: "eng",
    eng: "eng",
    ja: "jpn",
    jp: "jpn",
    jpn: "jpn",
    ru: "rus",
    rus: "rus",
  };
  return known[language.toLowerCase()] ?? (language.length === 3 ? language.toLowerCase() : "und");
}

function inferredAudioLanguage(trackName: string, fallback: string): string {
  if (/(?:^|[\s([])(?:japanese|японск)/i.test(trackName)) return "jpn";
  if (/(?:^|[\s([])(?:russian|русск)/i.test(trackName)) return "rus";
  return languageCode(fallback);
}

function audioTrackName(inputName: string | undefined, trackName: string | null): string {
  const name = trackName?.replace(/^\([^)]*\)\s*/, "").trim() ?? "";
  if (/(?:japanese|японск)/i.test(trackName ?? "")) return "Japanese";
  if (inputName && /subtitles?|субтитр|crunchyroll/i.test(inputName) && !/(?:russian|русск)/i.test(trackName ?? "")) {
    return "Japanese";
  }
  return inputName || name || trackName || "Audio";
}

async function digestHex(data: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function inspectAudioTracks(prepared: PreparedInput[]): Promise<Map<InputAudioTrack, AudioTrackInfo>> {
  const tracks = new Map<InputAudioTrack, AudioTrackInfo>();
  for (const item of prepared) {
    for (const track of await item.input.getAudioTracks()) {
      const originalName = await track.getName();
      const name = audioTrackName(item.name, originalName);
      const language = inferredAudioLanguage(originalName ?? name, await track.getLanguageCode());
      tracks.set(track, { language, name, track });
    }
  }
  return tracks;
}

function setAudioMetadata(
  output: Output,
  before: number,
  utilizedTracks: readonly InputTrack[],
  selectedAudio: Map<InputAudioTrack, AudioTrackInfo>,
): void {
  let outputIndex = before;
  for (const track of utilizedTracks) {
    const outputTrack = output.tracks[outputIndex];
    outputIndex += 1;
    if (!track.isAudioTrack() || !outputTrack || outputTrack.type !== "audio") continue;
    const selected = selectedAudio.get(track);
    if (!selected) continue;
    outputTrack.metadata.name = selected.name;
    outputTrack.metadata.languageCode = selected.language;
    outputTrack.metadata.disposition = {
      ...outputTrack.metadata.disposition,
      default: [...selectedAudio.values()][0]?.track === track,
      original: selected.language === "jpn",
    };
  }
}

function addSubtitle(output: Output, subtitle: DownloadSubtitle, text: string): () => Promise<void> {
  const source = new TextSubtitleSource("webvtt");
  output.addSubtitleTrack(source, {
    disposition: { default: subtitle.default, forced: subtitle.forced },
    languageCode: languageCode(subtitle.language),
    name: subtitle.name,
  });
  return () => source.add(text);
}

async function prepareSubtitles(
  output: Output,
  subtitles: DownloadSubtitle[],
  signal: AbortSignal,
): Promise<Array<() => Promise<void>>> {
  const fingerprints = new Set<string>();
  const writers: Array<() => Promise<void>> = [];
  for (const subtitle of subtitles) {
    const response = await checkedFetch(subtitle.url, subtitle, { signal });
    const text = await response.text();
    const normalized = new TextEncoder().encode(text.replaceAll("\r\n", "\n").trim());
    const fingerprint = await digestHex(normalized);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    writers.push(addSubtitle(output, subtitle, text));
  }
  return writers;
}

async function executeInLockstep(conversions: Conversion[]): Promise<void> {
  const step = 2;
  for (let until = step; ; until += step) {
    const active = conversions.filter((conversion) => conversion.state !== "done");
    if (active.length === 0) return;
    await Promise.all(active.map((conversion) => conversion.execute({ until })));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401|HTTP 410/i.test(message)) return "Ссылка на видео устарела. Обновите страницу и попробуйте снова.";
  if (/HTTP 403/i.test(message)) return "Сервер отклонил источник запроса. Не закрывайте вкладку с плеером и обновите страницу.";
  if (/DRM|зашифрован/i.test(message)) return message;
  return message || "Не удалось собрать видео";
}

async function opfsFile(jobId: string): Promise<{
  directory: FileSystemDirectoryHandle;
  handle: FileSystemFileHandle;
  name: string;
  writable: FileSystemWritableFileStream;
}> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(WORK_DIRECTORY, { create: true });
  const name = `${jobId}.partial`;
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { directory, handle, name, writable };
}

async function notify(jobId: string, status: "canceled" | "completed" | "downloading" | "failed" | "saving", progress: number, error?: string): Promise<void> {
  await chrome.runtime.sendMessage({ jobId, progress, status, type: "queue:update", ...(error ? { error } : {}) });
}

export async function runDownload(job: DownloadJob, signal: AbortSignal): Promise<void> {
  let temporary: Awaited<ReturnType<typeof opfsFile>> | undefined;
  const prepared: PreparedInput[] = [];
  const conversions: Conversion[] = [];
  let output: Output | undefined;
  const cancel = () => {
    for (const conversion of conversions) void conversion.cancel();
    for (const item of prepared) item.input.dispose();
    void output?.cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Загрузка отменена");
    await chrome.runtime.sendMessage({ job, type: "engine:prepare" });
    await notify(job.id, "downloading", 0);
    temporary = await opfsFile(job.id);
    output = new Output({
      format: job.container === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new MkvOutputFormat(),
      target: new StreamTarget(temporary.writable as unknown as WritableStream<StreamTargetChunk>, {
        chunked: true,
        chunkSize: 8 * 1024 * 1024,
      }),
    });
    output.setMetadataTags({ title: job.title });

    for (let index = 0; index < job.inputs.length; index += 1) {
      const source = job.inputs[index]!;
      const input = source.kind === "hls"
        ? await stageHlsInput(
          source,
          temporary.directory,
          `${job.id}.input-${index}.media`,
          signal,
          (value) => void notify(job.id, "downloading", ((index + value) / job.inputs.length) * 0.35),
        )
        : await prepareInput(source, signal);
      prepared.push(input);
      signal.throwIfAborted();
      if (job.expectedDuration) {
        const actual = await input.input.computeDuration();
        if (Math.abs(actual - job.expectedDuration) > Math.max(1, job.expectedDuration * 0.005)) {
          throw new Error("The file is incomplete or contains a preview. Open the full track in the source player and retry.");
        }
      }
      await notify(job.id, "downloading", ((index + 1) / job.inputs.length) * 0.35);
    }
    const selectedAudio = await inspectAudioTracks(prepared);
    const progress = new Map<Conversion, number>();
    for (const item of prepared) {
      const videoTracks = await item.input.getVideoTracks();
      const selectedVideo = await bestVideoTrack(videoTracks);
      const outputTrackCount = output.tracks.length;
      const conversion = await Conversion.init({
        composable: true,
        input: item.input,
        output,
        showWarnings: false,
        tracks: "all",
        video: (track: InputVideoTrack) => item.role === "audio" || track !== selectedVideo ? { discard: true } : {},
      });
      if (!conversion.isValid && conversion.utilizedTracks.length === 0) continue;
      setAudioMetadata(output, outputTrackCount, conversion.utilizedTracks, selectedAudio);
      conversion.onProgress = (value) => {
        progress.set(conversion, value);
        const total = [...progress.values()].reduce((sum, itemProgress) => sum + itemProgress, 0) / conversions.length;
        void notify(job.id, "downloading", Number.isFinite(total) ? 0.35 + total * 0.61 : 0.35);
      };
      conversions.push(conversion);
    }

    const subtitleWriters = await prepareSubtitles(output, job.subtitles, signal);
    if (!output.hasEnoughTracks()) throw new Error("В выбранном источнике нет совместимых видео- или аудиодорожек");
    await output.start();

    if (signal.aborted) cancel();
    await Promise.all([
      executeInLockstep(conversions),
      ...subtitleWriters.map((write) => write()),
    ]);
    if (signal.aborted) throw new Error("Загрузка отменена");
    await output.finalize();

    await notify(job.id, "saving", 0.98);
    const file = await temporary.handle.getFile();
    const mimeType = job.container === "mkv" ? "video/x-matroska"
      : job.inputs.every((input) => input.role === "audio") ? "audio/mp4" : "video/mp4";
    const objectUrl = URL.createObjectURL(file.slice(0, file.size, mimeType));
    try {
      const result = await chrome.runtime.sendMessage({ filename: job.filename, type: "download:save", url: objectUrl }) as { error?: string } | undefined;
      if (result?.error) throw new Error(result.error);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    await temporary.directory.removeEntry(temporary.name);
    temporary = undefined;
    await notify(job.id, "completed", 1);
  } catch (error) {
    if (output && output.state !== "canceled" && output.state !== "finalized") await output.cancel().catch(() => undefined);
    if (temporary) await temporary.directory.removeEntry(temporary.name).catch(() => undefined);
    if (signal.aborted) await notify(job.id, "canceled", 0);
    else await notify(job.id, "failed", 0, humanError(error));
  } finally {
    signal.removeEventListener("abort", cancel);
    for (const item of prepared) {
      item.input.dispose();
      await item.cleanup?.();
    }
    await chrome.runtime.sendMessage({ type: "engine:release" }).catch(() => undefined);
  }
}
