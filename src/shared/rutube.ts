export function parseRutubeVideoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !["rutube.ru", "www.rutube.ru"].includes(url.hostname)) return undefined;
    return url.pathname.match(/^\/(?:video|(?:play\/)?embed)\/([a-f0-9]{32})(?:\/|$)/i)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}
