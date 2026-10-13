export async function boundedText(response: Response): Promise<string> {
    const limit = 512 * 1024;
    if (Number(response.headers.get("content-length") ?? 0) > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Ответ источника слишком большой.");
    }

    const reader = response.body?.getReader();
    if (!reader) return "";

    let size = 0;
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
            if (chunk.done) return text + decoder.decode();

            size += chunk.value.byteLength;
            if (size > limit) throw new Error("Ответ источника слишком большой.");
            text += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
