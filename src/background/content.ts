function missingReceiver(error: unknown): boolean {
  return error instanceof Error && /could not establish connection|receiving end does not exist/i.test(error.message);
}

const connections = new Map<number, Promise<void>>();

export function connectTabContent(tabId: number): Promise<void> {
  const pending = connections.get(tabId);
  if (pending) return pending;
  const operation = reconnectTab(tabId).finally(() => connections.delete(tabId));
  connections.set(tabId, operation);
  return operation;
}

async function reconnectTab(tabId: number): Promise<void> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const sourceFrames = (frames ?? []).filter(frame => /^(?:https?:|about:(?:blank|srcdoc))/.test(frame.url));
  await Promise.all(sourceFrames.map(async frame => {
    const target = { documentId: frame.documentId };
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "ready" }, target) as
        { url?: string } | undefined;
      if (response?.url === frame.url) return;
    } catch (error) {
      if (!missingReceiver(error)) throw error;
    }
    await chrome.scripting.executeScript({
      files: ["content/bridge.js"],
      injectImmediately: true,
      target: { tabId, documentIds: [frame.documentId] },
    });
    await chrome.tabs.sendMessage(tabId, { type: "bridge:refresh" }, target);
  }));
}

export async function sendYummyMessage<T>(tabId: number, message: object): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as T;
  } catch (error) {
    if (!missingReceiver(error)) throw error;
  }

  try {
    await connectTabContent(tabId);
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }) as T;
  } catch (error) {
    if (missingReceiver(error)) {
      throw new Error("Не удалось подключиться к странице YummyAnime. Обновите вкладку и повторите попытку.");
    }
    throw error;
  }
}
