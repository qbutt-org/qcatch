const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/g;
const QUALITY_SUFFIX =
  /(?:[ ._-]+(?:2160|1440|1080|720|576|480|360)p|\s*[\[(](?:2160|1440|1080|720|576|480|360)p[)\]])$/i;

export function safeFilename(value: string, fallback = "video"): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(INVALID_WINDOWS_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(TRAILING_DOTS_AND_SPACES, "")
    .trim();
  return cleaned || fallback;
}

export function withoutQualitySuffix(value: string): string {
  return value.replace(QUALITY_SUFFIX, "").trim();
}

export function buildFilename(
  title: string,
  extension: string,
  episode?: number,
): string {
  const base = withoutQualitySuffix(safeFilename(title));
  const episodePart =
    episode === undefined ? "" : ` - ${String(episode).padStart(2, "0")}`;
  return `${base}${episodePart}.${extension}`;
}
