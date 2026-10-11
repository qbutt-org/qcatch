import type { PopupPreferences } from "../shared/types.ts";

function key(tabId: number): string {
  return `preferences:${tabId}`;
}

function pageIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

export async function readPreferences(tabId: number, pageUrl: string): Promise<PopupPreferences | undefined> {
  const stored = await chrome.storage.session.get(key(tabId));
  const preferences = stored[key(tabId)] as PopupPreferences | undefined;
  return preferences && pageIdentity(preferences.pageUrl) === pageIdentity(pageUrl) ? preferences : undefined;
}

export async function writePreferences(tabId: number, preferences: PopupPreferences): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: preferences });
}

export async function removePreferences(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId));
}
