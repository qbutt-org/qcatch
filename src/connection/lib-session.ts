import { cookies } from "./cookies.ts";

const API_URL = "https://api.cdnlibs.org/api/";
const SITE_URLS = ["https://mangalib.me/", "https://ranobelib.me/"];

export class LibSessionError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

function canceled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        operation.then(value => {
            signal.removeEventListener("abort", abort);
            resolve(value);
        }, error => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}

// Runs in an isolated extension world on the exact requested site's document.
// Never return the persisted user, refresh token or the rest of localStorage.
function readAccessToken(origin: string) {
    if (location.origin !== origin) return { changed: true };
    const stored = localStorage.getItem("auth");
    if (!stored) return { accessToken: null };
    if (stored.length > 256 * 1024) return { invalid: true };
    try {
        const token = JSON.parse(stored)?.token;
        if (!token) return { accessToken: null };
        const value = token.access_token;
        if (typeof value !== "string" || !value.length || value.length > 16 * 1024
            || !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) return { invalid: true };
        if (typeof token.timestamp === "number" && typeof token.expires_in === "number"
            && token.timestamp + token.expires_in * 1000 <= Date.now()) return { expired: true };
        return { accessToken: value };
    } catch {
        return { invalid: true };
    }
}

export async function libSession(url: string, signal: AbortSignal) {
    if (!SITE_URLS.includes(url)) throw new LibSessionError("browser_invalid_request");
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const origin = new URL(url).origin;
    let opening: Promise<chrome.tabs.Tab> | undefined;
    let expired = false;

    async function openSite(): Promise<number> {
        const windows = await canceled(chrome.windows.getAll({ windowTypes: ["normal"] }), bounded);
        const window = windows.find(candidate => !candidate.incognito && candidate.focused)
            ?? windows.find(candidate => !candidate.incognito);
        if (window?.id === undefined) throw new LibSessionError("browser_required");
        bounded.throwIfAborted();
        opening = chrome.tabs.create({ url: "about:blank", active: false, windowId: window.id });
        const tab = await canceled(opening, bounded);
        if (tab.id === undefined) throw new LibSessionError("browser_error");
        await canceled(chrome.tabs.update(tab.id, { muted: true, url }), bounded);
        return tab.id;
    }

    try {
        const tabs = await canceled(chrome.tabs.query({ url: `${origin}/*` }), bounded);
        const tab = tabs.find(candidate => !candidate.incognito && candidate.id !== undefined);
        let tabId = tab?.id ?? await openSite();
        for (;;) {
            bounded.throwIfAborted();
            const current = await canceled(chrome.tabs.get(tabId), bounded);
            if (current.url && current.url !== "about:blank" && new URL(current.url).origin !== origin) {
                throw new LibSessionError("browser_check_required");
            }
            if (current.url?.startsWith(`${origin}/`)) {
                const results = await canceled(chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    world: "ISOLATED",
                    func: readAccessToken,
                    args: [origin],
                }), bounded);
                const result = results[0]?.result;
                if (!result || result.changed) throw new LibSessionError("selected_content_changed");
                if (result.invalid) throw new LibSessionError("browser_invalid_response");
                if (!result.expired) {
                    if (expired && result.accessToken === null) throw new LibSessionError("login_required");
                    return { accessToken: result.accessToken, cookies: await canceled(cookies(API_URL), bounded) };
                }
                // The site's own requests refresh its token. Observe the new
                // value within this deadline; qcatch never exports or uses refresh_token.
                expired = true;
                if (!opening) tabId = await openSite();
            }
            await canceled(new Promise(resolve => setTimeout(resolve, 100)), bounded);
        }
    } catch (error) {
        if (signal.aborted) throw error;
        if (bounded.aborted) throw new LibSessionError(expired ? "login_required" : "browser_timeout");
        throw error;
    } finally {
        // A canceled tabs.create may complete later: keep its cleanup attached.
        if (opening) {
            const cleanup = opening.then(tab => tab.id === undefined ? undefined : chrome.tabs.remove(tab.id))
                .catch(() => undefined);
            await canceled(cleanup, bounded).catch(() => undefined);
        }
    }
}
