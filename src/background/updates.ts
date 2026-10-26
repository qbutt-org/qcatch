import { connectionBusy } from "../connection/background.ts";
import type { NativeHealth } from "../shared/native.ts";
import { browserLanguage, translate } from "../shared/localization.ts";
import { actionsBusy } from "./action.ts";
import { bridgeRequest, nativeBusy } from "./native.ts";
import { platformsBusy } from "./platforms.ts";
import { productsBusy } from "./product-actions.ts";
import { readQueue } from "./queue.ts";

const ALARM = "qcatch:updates";
const RELOADED = "qcatch:update-reloaded";
const NOTIFIED = "qcatch:update-notified";
const NOTICE = "qcatch-extension-update";
let pending: Promise<void> | undefined;

function newer(candidate: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const expected = candidate.split(".").map(Number);
  const installed = current.split(".").map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== installed[index]) return expected[index]! > installed[index]!;
  }
  return false;
}

async function idle(): Promise<boolean> {
  if (nativeBusy() || connectionBusy() || actionsBusy() || platformsBusy() || productsBusy()) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
  if (contexts.length) return false;
  const queue = await readQueue();
  return !queue.items.some(item => !["completed", "failed", "canceled"].includes(item.status));
}

async function reload(health: NativeHealth): Promise<void> {
  if (!newer(health.version, chrome.runtime.getManifest().version) || !await idle()) return;
  const saved = await chrome.storage.local.get([RELOADED, NOTIFIED, "language"]);
  if (saved[RELOADED] !== health.version) {
    await chrome.storage.local.set({ [RELOADED]: health.version });
    chrome.runtime.reload();
    return;
  }
  if (saved[NOTIFIED] === health.version) return;
  const language = saved.language === "ru" || saved.language === "en"
    ? saved.language : browserLanguage(navigator.languages);
  await chrome.notifications.create(NOTICE, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: "qcatch",
    message: translate(language, "Подключите расширение из обновлённой папки qcatch. Нажмите, чтобы открыть её."),
  });
  await chrome.storage.local.set({ [NOTIFIED]: health.version });
}

async function check(): Promise<void> {
  if (!await idle()) return;
  let health = await bridgeRequest("/health") as NativeHealth;
  await reload(health);
  if (health.update?.state !== "ready" || !await idle()) return;
  const result = await bridgeRequest("/updates/apply", {}) as { accepted: boolean };
  if (!result.accepted) return;
  const previous = health.version;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      health = await bridgeRequest("/health") as NativeHealth;
      if (newer(health.version, previous)) {
        await reload(health);
        return;
      }
    } catch {
      // The installer replaces and restarts the local helper.
    }
  }
}

function poll(): void {
  if (pending) return;
  pending = check().catch(() => undefined).finally(() => { pending = undefined; });
}

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) poll(); });
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.notifications.onClicked.addListener(id => {
  if (id !== NOTICE) return;
  void bridgeRequest("/extension/setup", { browser: /Edg\//.test(navigator.userAgent) ? "edge" : "chrome" })
    .catch(() => undefined);
});
void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
poll();
