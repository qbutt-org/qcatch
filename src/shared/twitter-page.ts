const TWITTER_HOSTS = new Set(["twitter.com", "x.com", "vxtwitter.com", "fixvx.com"]);

export type TwitterPostReference = { id: string; index?: number };

export function parseTwitterPostUrl(value: string | undefined): TwitterPostReference | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^(?:(?:www|mobile)\.)+/, "");
    if (!TWITTER_HOSTS.has(hostname)) return undefined;

    const bookmarkId = url.searchParams.get("post_id");
    if (
      bookmarkId
      && /^\/i\/bookmarks\/?$/.test(url.pathname)
      && /^\d{1,19}$/.test(bookmarkId)
    ) {
      return { id: bookmarkId };
    }

    const match = url.pathname.match(
      /^\/[^/]+\/status\/(\d{1,19})(?:\/(?:video|photo)\/(\d+))?(?:\/|$)/i,
    );
    if (!match?.[1]) return undefined;
    const index = match[2] ? Number(match[2]) - 1 : undefined;
    return index !== undefined && Number.isInteger(index) && index >= 0
      ? { id: match[1], index }
      : { id: match[1] };
  } catch {
    return undefined;
  }
}

export function isTwitterPostUrl(value: string | undefined): boolean {
  return parseTwitterPostUrl(value) !== undefined;
}
