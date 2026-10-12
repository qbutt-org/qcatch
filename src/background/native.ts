import { NATIVE_BRIDGE_URL } from "../shared/native.ts";

export class NativeBridgeError extends Error {
  constructor(message: string, readonly deliveryUncertain = false) {
    super(message);
    this.name = "NativeBridgeError";
  }
}

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
    throw new NativeBridgeError(
      "Локальный помощник не отвечает. Установите или запустите qcatch и повторите попытку.",
      body !== undefined,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new NativeBridgeError("Ответ приложения не удалось прочитать.", body !== undefined);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new NativeBridgeError("Ответ приложения не удалось прочитать.", body !== undefined);
  }
  const error = "error" in result && typeof result.error === "string" ? result.error : undefined;
  if (!response.ok || error)
    throw new NativeBridgeError(
      error ?? `Ошибка локального помощника (${response.status}).`,
    );
  return result;
}
