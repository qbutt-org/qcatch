export type FileDashMedia = {
  url: string;
  kind: "video";
  audioTracks: Array<{ url: string; name?: string }>;
};

// A static SegmentBase MPD points at complete files, unlike the segmented DASH downloader.
// This function runs in the selected page, which supplies DOMParser and its document binding.
export function readFileDashAssets(
  xml: string,
  manifestUrl: string,
  pageUrl: string,
  requireAudio: boolean,
): FileDashMedia | { error: string } {
  const unavailable = "The source did not return this media. Open it in the site's player and retry.";
  type Format = { url: string; width: number; height: number; bitrate: number };
  const best = (formats: Format[]) => formats.sort((left, right) =>
    right.width * right.height - left.width * left.height || right.bitrate - left.bitrate,
  )[0];
  try {
    if (location.href !== pageUrl) throw new Error("The page changed. Open the media again and retry.");
    const manifest = new DOMParser().parseFromString(xml, "application/xml");
    if (manifest.querySelector("ContentProtection")) throw new Error("DRM-protected media cannot be downloaded.");
    const mpd = manifest.documentElement;
    const periods = manifest.querySelectorAll("Period");
    if (
      mpd.localName !== "MPD" || manifest.querySelector("parsererror")
      || mpd.getAttribute("type") === "dynamic" || periods.length !== 1
      || manifest.querySelector("SegmentTemplate, SegmentList")
    ) throw new Error(unavailable);

    const video: Format[] = [];
    const audioTracks: FileDashMedia["audioTracks"] = [];
    for (const adaptation of manifest.querySelectorAll("AdaptationSet")) {
      const audio: Format[] = [];
      for (const representation of adaptation.querySelectorAll("Representation")) {
        let base = manifestUrl;
        for (const owner of [mpd, periods[0]!, adaptation, representation]) {
          const value = [...owner.children].find(child => child.localName === "BaseURL")?.textContent?.trim();
          if (value) base = new URL(value, base).href;
        }
        const url = new URL(base);
        if (url.protocol !== "https:" || url.username || url.password || base === manifestUrl) throw new Error(unavailable);
        const mime = representation.getAttribute("mimeType") ?? adaptation.getAttribute("mimeType") ?? "";
        const format = {
          url: url.href,
          width: Number(representation.getAttribute("width")),
          height: Number(representation.getAttribute("height")),
          bitrate: Number(representation.getAttribute("bandwidth")),
        };
        if (mime.startsWith("video/")) video.push(format);
        else if (mime.startsWith("audio/")) audio.push(format);
      }
      const selected = best(audio);
      const name = adaptation.getAttribute("lang");
      if (selected) audioTracks.push({ url: selected.url, ...(name && name !== "und" ? { name } : {}) });
    }
    const selected = best(video);
    if (!selected || (requireAudio && !audioTracks.length)) throw new Error(unavailable);
    return { url: selected.url, kind: "video", audioTracks };
  } catch (error) {
    return { error: error instanceof Error ? error.message : unavailable };
  }
}
