export type DashSegment = {
  duration: number;
  url: string;
};

export type DashRepresentation = {
  bandwidth: number;
  codecs: string;
  height?: number;
  id: string;
  initUrl: string;
  language: string;
  mimeType: string;
  name: string;
  segments: DashSegment[];
  type: "audio" | "video";
  width?: number;
};

export type DashManifest = {
  audio: DashRepresentation[];
  duration: number;
  video: DashRepresentation[];
};

type DashTemplate = {
  initialization: string;
  media: string;
  startNumber: number;
  timeline?: Element;
  timescale: number;
  segmentDuration?: number;
};

export function parseIsoDuration(value: string | null): number {
  if (!value) return 0;
  const match = value.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 86_400
    + Number(match[2] ?? 0) * 3_600
    + Number(match[3] ?? 0) * 60
    + Number(match[4] ?? 0);
}

export function fillDashTemplate(
  template: string,
  values: { bandwidth: number; id: string; number: number; time: number },
): string {
  return template
    .replaceAll("$$", "\u0000")
    .replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%(0\d+)d)?\$/g, (_, key: string, width: string | undefined) => {
      const raw = key === "RepresentationID"
        ? values.id
        : String(values[key.toLowerCase() as "bandwidth" | "number" | "time"]);
      return width ? raw.padStart(Number(width), "0") : raw;
    })
    .replaceAll("\u0000", "$");
}

function directChild(element: Element, tagName: string): Element | undefined {
  return [...element.children].find((child) => child.localName === tagName);
}

function inheritedAttribute(
  representation: Element,
  adaptation: Element,
  name: string,
): string | null {
  return representation.getAttribute(name) ?? adaptation.getAttribute(name);
}

function resolvedBaseUrl(elements: Element[], manifestUrl: string): string {
  let current = manifestUrl;
  for (const element of elements) {
    const value = directChild(element, "BaseURL")?.textContent?.trim();
    if (value) current = new URL(value, current).href;
  }
  return current;
}

function readTemplate(representation: Element, adaptation: Element): DashTemplate {
  const representationTemplate = directChild(representation, "SegmentTemplate");
  const adaptationTemplate = directChild(adaptation, "SegmentTemplate");
  const attribute = (name: string): string | null =>
    representationTemplate?.getAttribute(name) ?? adaptationTemplate?.getAttribute(name) ?? null;
  const media = attribute("media");
  const initialization = attribute("initialization");
  if (!media || !initialization) throw new Error("DASH SegmentTemplate без media/initialization пока не поддерживается");
  const timeline = representationTemplate
    ? directChild(representationTemplate, "SegmentTimeline")
    : undefined;
  const inheritedTimeline = timeline ?? (adaptationTemplate ? directChild(adaptationTemplate, "SegmentTimeline") : undefined);
  return {
    initialization,
    media,
    startNumber: Number(attribute("startNumber") ?? 1),
    timescale: Number(attribute("timescale") ?? 1),
    ...(inheritedTimeline ? { timeline: inheritedTimeline } : {}),
    ...(attribute("duration") ? { segmentDuration: Number(attribute("duration")) } : {}),
  };
}

function segmentPoints(template: DashTemplate, periodDuration: number): Array<{ duration: number; number: number; time: number }> {
  if (template.timeline) {
    const elements = [...template.timeline.children].filter((element) => element.localName === "S");
    const points: Array<{ duration: number; number: number; time: number }> = [];
    let time = 0;
    let number = template.startNumber;
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const duration = Number(element.getAttribute("d"));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Некорректный DASH SegmentTimeline");
      time = Number(element.getAttribute("t") ?? time);
      let repeat = Number(element.getAttribute("r") ?? 0);
      if (repeat < 0) {
        const nextTime = elements[index + 1]?.getAttribute("t");
        const end = nextTime ? Number(nextTime) : Math.round(periodDuration * template.timescale);
        if (!end) throw new Error("Бесконечный DASH SegmentTimeline не поддерживается");
        repeat = Math.max(0, Math.ceil((end - time) / duration) - 1);
      }
      for (let occurrence = 0; occurrence <= repeat; occurrence += 1) {
        points.push({ duration: duration / template.timescale, number, time });
        number += 1;
        time += duration;
      }
    }
    return points;
  }

  if (!template.segmentDuration || !periodDuration) {
    throw new Error("DASH без SegmentTimeline или длительности сегментов не поддерживается");
  }
  const segmentDuration = template.segmentDuration;
  const segmentCount = Math.ceil(periodDuration * template.timescale / segmentDuration);
  return Array.from({ length: segmentCount }, (_, index) => ({
    duration: Math.min(segmentDuration / template.timescale, periodDuration - index * segmentDuration / template.timescale),
    number: template.startNumber + index,
    time: index * segmentDuration,
  }));
}

export function parseDashManifest(xml: string, manifestUrl: string): DashManifest {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) throw new Error("Не удалось разобрать DASH-манифест");
  const mpd = document.documentElement;
  if (mpd.localName !== "MPD") throw new Error("Ответ не является DASH MPD");
  if (mpd.getAttribute("type") === "dynamic") throw new Error("Прямые эфиры DASH пока не поддерживаются");
  if (mpd.querySelector("ContentProtection")) throw new Error("Это видео защищено DRM и не поддерживается");

  const mpdDuration = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
  const audio: DashRepresentation[] = [];
  const video: DashRepresentation[] = [];

  for (const period of [...mpd.children].filter((element) => element.localName === "Period")) {
    const periodDuration = parseIsoDuration(period.getAttribute("duration")) || mpdDuration;
    for (const adaptation of [...period.children].filter((element) => element.localName === "AdaptationSet")) {
      const contentType = adaptation.getAttribute("contentType")
        ?? adaptation.getAttribute("mimeType")?.split("/")[0]
        ?? "";
      if (contentType !== "audio" && contentType !== "video") continue;
      for (const representation of [...adaptation.children].filter((element) => element.localName === "Representation")) {
        const id = representation.getAttribute("id") ?? `${contentType}-${contentType === "video" ? video.length : audio.length + 1}`;
        const bandwidth = Number(representation.getAttribute("bandwidth") ?? 0);
        const template = readTemplate(representation, adaptation);
        const baseUrl = resolvedBaseUrl([mpd, period, adaptation, representation], manifestUrl);
        const values = { bandwidth, id, number: template.startNumber, time: 0 };
        const points = segmentPoints(template, periodDuration);
        const item: DashRepresentation = {
          bandwidth,
          codecs: inheritedAttribute(representation, adaptation, "codecs") ?? "",
          id,
          initUrl: new URL(fillDashTemplate(template.initialization, values), baseUrl).href,
          language: inheritedAttribute(representation, adaptation, "lang") ?? "und",
          mimeType: inheritedAttribute(representation, adaptation, "mimeType") ?? `${contentType}/mp4`,
          name: inheritedAttribute(representation, adaptation, "label") ?? id,
          segments: points.map((point) => ({
            duration: point.duration,
            url: new URL(fillDashTemplate(template.media, { ...values, number: point.number, time: point.time }), baseUrl).href,
          })),
          type: contentType,
          ...(representation.getAttribute("height") ? { height: Number(representation.getAttribute("height")) } : {}),
          ...(representation.getAttribute("width") ? { width: Number(representation.getAttribute("width")) } : {}),
        };
        (contentType === "video" ? video : audio).push(item);
      }
    }
  }

  if (video.length === 0 && audio.length === 0) throw new Error("В DASH-манифесте нет поддерживаемых дорожек");
  return { audio, duration: mpdDuration, video };
}

export function bestDashVideo(video: readonly DashRepresentation[]): DashRepresentation | undefined {
  return [...video].sort((left, right) => {
    const pixels = (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0);
    return pixels || right.bandwidth - left.bandwidth;
  })[0];
}

function quoteHls(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function mediaPlaylist(representation: DashRepresentation): string {
  const targetDuration = Math.max(1, Math.ceil(Math.max(...representation.segments.map((segment) => segment.duration))));
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MAP:URI="${quoteHls(representation.initUrl)}"`,
    ...representation.segments.flatMap((segment) => [`#EXTINF:${segment.duration.toFixed(6)},`, segment.url]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

export function dashToHls(manifest: DashManifest): { cleanup: () => void; url: string } {
  const selectedVideo = bestDashVideo(manifest.video);
  const mediaUrls: string[] = [];
  const createMediaUrl = (representation: DashRepresentation): string => {
    const url = URL.createObjectURL(new Blob([mediaPlaylist(representation)], { type: "application/vnd.apple.mpegurl" }));
    mediaUrls.push(url);
    return url;
  };

  const audio = manifest.audio.map((representation, index) => ({
    representation,
    url: createMediaUrl(representation),
    default: index === 0,
  }));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const item of audio) {
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${quoteHls(item.representation.name)}",LANGUAGE="${quoteHls(item.representation.language)}",DEFAULT=${item.default ? "YES" : "NO"},AUTOSELECT=YES,URI="${quoteHls(item.url)}"`);
  }
  if (selectedVideo) {
    const resolution = selectedVideo.width && selectedVideo.height
      ? `,RESOLUTION=${selectedVideo.width}x${selectedVideo.height}`
      : "";
    const codecs = selectedVideo.codecs ? `,CODECS="${quoteHls(selectedVideo.codecs)}"` : "";
    const audioGroup = audio.length > 0 ? ',AUDIO="audio"' : "";
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${selectedVideo.bandwidth || 1}${resolution}${codecs}${audioGroup}`);
    lines.push(createMediaUrl(selectedVideo));
  } else if (audio[0]) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${audio[0].representation.bandwidth || 1},AUDIO="audio"`);
    lines.push(audio[0].url);
  }
  lines.push("");
  const masterUrl = URL.createObjectURL(new Blob([lines.join("\n")], { type: "application/vnd.apple.mpegurl" }));
  return {
    cleanup: () => {
      URL.revokeObjectURL(masterUrl);
      for (const url of mediaUrls) URL.revokeObjectURL(url);
    },
    url: masterUrl,
  };
}
