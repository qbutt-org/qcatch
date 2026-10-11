import type { VkSearchVideo } from "../shared/connection.ts";

export function vkSearchUrl(query: string): string {
    if (!query || query !== query.trim() || query.length > 200 || /[\r\n]/.test(query)) {
        throw new Error("Enter a search query of up to 200 characters.");
    }
    const url = new URL("https://vkvideo.ru/");
    url.searchParams.set("q", query);
    return url.href;
}

function text(element: Element | null, limit: number): string {
    return (element?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function duration(value: string): number | undefined {
    const clock = /(?:^|\s)(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!clock || Number(clock[2]) >= 60 || clock[3] && Number(clock[3]) >= 60) return;
    return clock[3] ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
        : Number(clock[1]) * 60 + Number(clock[2]);
}

export function readVkSearch(document: Document, query: string): { ready: boolean; videos: VkSearchVideo[] } {
    const page = new URL(document.URL);
    const input = document.querySelector<HTMLInputElement>("#video_service_search_input");
    const list = document.querySelector('[data-testid="list_catalog_videos"]');
    const loading = [...document.querySelectorAll('[data-testid="loading-skeleton"], .vkuiScreenSpinner__spinner[role="status"]')]
        .some(element => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            && element.getBoundingClientRect().height > 0);
    if (page.origin !== "https://vkvideo.ru" || page.pathname !== "/" || page.searchParams.get("q") !== query
        || input?.value !== query || !list || loading) {
        return { ready: false, videos: [] };
    }

    const videos = new Map<string, VkSearchVideo>();
    for (const card of [...list.querySelectorAll('[data-testid="video_card_layout"]')].slice(0, 100)) {
        const titleElement = card.querySelector('[data-testid="video_card_title"]');
        const link = titleElement?.querySelector<HTMLAnchorElement>("a[href]");
        const title = text(titleElement, 500);
        if (!link || !title) continue;
        let url: URL;
        try { url = new URL(link.getAttribute("href")!, page); }
        catch { continue; }
        const id = /^\/video(-?\d+_\d+)$/.exec(url.pathname)?.[1];
        if (!id || url.origin !== page.origin || url.username || url.password) continue;
        const author = text(card.querySelector('[data-testid="video_card_owner"]'), 200);
        const seconds = duration(text(card.querySelector('[data-testid="video_card_duration"]'), 100));
        const image = card.querySelector<HTMLImageElement>('[data-testid="video_card_thumb"] img');
        let cover: string | undefined;
        if (image?.getAttribute("src")) {
            try {
                const address = new URL(image.getAttribute("src")!, page);
                if (address.protocol === "https:" && !address.username && !address.password) cover = address.href;
            } catch { /* An invalid optional thumbnail does not change the publication. */ }
        }
        videos.set(id, { id, title, url: `https://vkvideo.ru/video${id}`,
            ...(author ? { author } : {}), ...(seconds === undefined ? {} : { duration: seconds }),
            ...(cover ? { cover } : {}) });
    }
    // VK's generic placeholder does not distinguish an empty search from a rejected query.
    return { ready: videos.size > 0, videos: [...videos.values()] };
}
