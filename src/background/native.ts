import { NATIVE_BRIDGE_URL } from "../shared/native.ts";

export async function bridgeRequest(
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${NATIVE_BRIDGE_URL}${path}`, {
      headers: { "Content-Type": "application/json", "X-Qcatch": "1" },
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      "Локальный помощник не отвечает. Установите или запустите qcatch и повторите попытку.",
    );
  }
  const result = (await response.json()) as { error?: string };
  if (!response.ok || result.error)
    throw new Error(
      result.error ?? `Ошибка локального помощника (${response.status}).`,
    );
  return result;
}
