export async function readManifest(url: string, expectedPage: string, frameName: string, credentials: RequestCredentials) {
    const limit = 512 * 1024;
    const signal = AbortSignal.timeout(15_000);
    if (location.href !== expectedPage || (frameName !== "" && window.name !== frameName)) {
        return { error: "selected_content_changed" } as const;
    }
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
        response = await fetch(url, { credentials, signal });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok) return { status: response.status, url: response.url, contentType, body: "" };
        if (Number(response.headers.get("content-length") ?? 0) > limit) {
            return { error: "response_too_large" } as const;
        }

        const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
        const decoder = new TextDecoder(charset);
        reader = response.body?.getReader();
        let body = "";
        let bytes = 0;
        while (reader) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > limit) return { error: "response_too_large" } as const;
            body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        if (new TextEncoder().encode(body).byteLength > limit) return { error: "response_too_large" } as const;

        if (location.href !== expectedPage || (frameName !== "" && window.name !== frameName)) {
            return { error: "selected_content_changed" } as const;
        }
        return { status: response.status, url: response.url, contentType, body };
    } catch {
        return { error: signal.aborted ? "browser_timeout" : "browser_error" } as const;
    } finally {
        if (reader) await reader.cancel().catch(() => undefined);
        else await response?.body?.cancel().catch(() => undefined);
    }
}
