export class ResponseTooLargeError extends Error {
    constructor() {
        super("Ответ источника слишком большой.");
    }
}

export async function boundedText(response: Response, limit = 512 * 1024): Promise<string> {
    if (Number(response.headers.get("content-length") ?? 0) > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
    }

    const reader = response.body?.getReader();
    if (!reader) return "";

    let receivedBytes = 0;
    let text = "";
    try {
        const charset = response.headers.get("content-type")
            ?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
        let decoder: TextDecoder;
        try {
            decoder = new TextDecoder(charset);
        } catch {
            throw new Error(`Источник объявил неподдерживаемую кодировку ответа: ${charset}.`);
        }

        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                const body = text + decoder.decode();
                if (new TextEncoder().encode(body).byteLength > limit) {
                    throw new ResponseTooLargeError();
                }
                return body;
            }

            receivedBytes += chunk.value.byteLength;
            if (receivedBytes > limit) throw new ResponseTooLargeError();
            text += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
