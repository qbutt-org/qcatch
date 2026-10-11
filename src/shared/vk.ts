const VK_HOSTS = new Set(["vk.com", "vk.ru", "vkvideo.com", "vkvideo.ru", "vkontakte.com", "vkontakte.ru"]);

export type VkVideoReference = { id: string; list?: string };

export function parseVkVideoUrl(value: string | undefined): VkVideoReference | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|m|new|vksport)\./, "");
    if (!/^https?:$/.test(url.protocol) || !VK_HOSTS.has(hostname)) return undefined;

    const overlay = url.searchParams.get("z");
    const match = (overlay ?? url.pathname.slice(1)).match(/^video(-?\d+_\d+)(?:\/([^/]+))?(?:\/|$)/);
    if (!match?.[1]) return undefined;
    const list = match[2] ?? url.searchParams.get("list");
    return list ? { id: match[1], list } : { id: match[1] };
  } catch {
    return undefined;
  }
}
