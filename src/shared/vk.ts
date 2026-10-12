const VK_HOSTS = new Set(["vk.com", "vk.ru", "vkvideo.com", "vkvideo.ru", "vkontakte.com", "vkontakte.ru"]);

export type VkVideoReference = { id: string; list?: string; accessKey?: string };

export function parseVkVideoUrl(value: string | undefined): VkVideoReference | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|m|new|vksport)\./, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !VK_HOSTS.has(hostname)) return undefined;

    const overlay = url.searchParams.get("z");
    const match = (overlay ?? url.pathname.slice(1)).match(/^video(-?\d+_\d+)(?:\/([^/]+))?(?:\/|$)/);
    const embeddedId = url.pathname === "/video_ext.php"
      ? `${url.searchParams.get("oid")}_${url.searchParams.get("id")}` : undefined;
    const id = match?.[1] ?? embeddedId;
    if (!id || !/^-?\d+_\d+$/.test(id)) return undefined;
    const list = match?.[2] ?? url.searchParams.get("list");
    const accessKey = url.searchParams.get("access_key");
    return { id, ...(list ? { list } : {}), ...(accessKey ? { accessKey } : {}) };
  } catch {
    return undefined;
  }
}
