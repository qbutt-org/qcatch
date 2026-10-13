import { boundedText, ResponseTooLargeError } from "./response.ts";
import { MAX_FETCH_BODY_BYTES, type BrowserCommand } from "../shared/connection.ts";

interface FetchMessage {
    type: "qbutt:document-fetch";
    token: string;
    documentToken: string;
    expectedPage: string;
    url: string;
    init?: BrowserCommand["init"];
}

const documentToken = crypto.randomUUID();
const requests = new Map<string, AbortController>();

async function fetchDocument(message: FetchMessage, controller: AbortController) {
    const deadline = AbortSignal.timeout(17_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    try {
        const request = new URL(message.url);
        if (message.documentToken !== documentToken || location.href !== message.expectedPage
            || request.origin !== location.origin) {
            return { error: { code: "selected_content_changed", message: "Страница источника изменилась." } };
        }

        const response = await fetch(request, {
            ...message.init,
            credentials: "include",
            mode: "same-origin",
            signal,
        });
        const body = await boundedText(response, MAX_FETCH_BODY_BYTES);
        signal.throwIfAborted();

        if (location.href !== message.expectedPage || new URL(response.url).origin !== request.origin) {
            return { error: { code: "selected_content_changed", message: "Страница источника изменилась." } };
        }

        return {
            status: response.status,
            url: response.url,
            headers: Object.fromEntries(response.headers),
            body,
        };
    } catch (error) {
        if (controller.signal.aborted) {
            return { error: { code: "canceled", message: "Запрос отменён." } };
        }
        if (deadline.aborted) {
            return { error: { code: "browser_timeout", message: "Источник не ответил вовремя." } };
        }
        return {
            error: {
                code: error instanceof ResponseTooLargeError ? "response_too_large" : "browser_error",
                message: error instanceof Error ? error.message : "Не удалось прочитать источник.",
            },
        };
    }
}

chrome.runtime.onMessage.addListener((value: unknown, _sender, respond) => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;

    if (message.type === "qbutt:document-fetch:identity") {
        respond({ url: location.href, documentToken });
        return;
    }

    if (message.type === "qbutt:document-fetch:cancel") {
        if (message.documentToken === documentToken && typeof message.token === "string") {
            requests.get(message.token)?.abort();
        }
        respond({ canceled: true });
        return;
    }

    if (message.type !== "qbutt:document-fetch" || typeof message.token !== "string"
        || typeof message.url !== "string" || typeof message.expectedPage !== "string"
        || typeof message.documentToken !== "string") return;

    const token = message.token;
    if (requests.has(token)) {
        respond({ error: { code: "browser_error", message: "Запрос источника уже выполняется." } });
        return;
    }

    const controller = new AbortController();
    requests.set(token, controller);
    void fetchDocument(message as unknown as FetchMessage, controller)
        .then(respond)
        .finally(() => requests.delete(token));
    return true;
});
