function missingReceiver(error: unknown): boolean {
  return error instanceof Error && /could not establish connection|receiving end does not exist/i.test(error.message);
}

async function installYummyBridge(tabId: number): Promise<void> {
  const target = { tabId };
  await chrome.scripting.executeScript({ files: ["content/sniffer.js"], injectImmediately: true, target, world: "MAIN" });
  await chrome.scripting.executeScript({ files: ["content/bridge.js"], injectImmediately: true, target });
}

export async function sendYummyMessage<T>(tabId: number, message: object): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as T;
  } catch (error) {
    if (!missingReceiver(error)) throw error;
  }

  try {
    await installYummyBridge(tabId);
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as T;
  } catch (error) {
    if (missingReceiver(error)) {
      throw new Error("Не удалось подключиться к странице YummyAnime. Обновите вкладку и повторите попытку.");
    }
    throw error;
  }
}
