import type { DownloadJob, QueueSnapshot } from "../shared/types.ts";
import { addQueueJobs, updateQueueItem } from "./queue.ts";

const REPLAY_RULE_ID = 31_415;
const REPLAY_RULE_LIMIT = 64;
let offscreenCreation: Promise<void> | undefined;

export async function enqueueDownloads(jobs: DownloadJob[]): Promise<QueueSnapshot> {
  const queue = await addQueueJobs(jobs);
  let started = 0;
  try {
    await ensureOffscreenDocument();
    for (const job of jobs) {
      await chrome.runtime.sendMessage({ job, target: "offscreen", type: "offscreen:run" });
      started += 1;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await Promise.all(jobs.slice(started).map((job) => updateQueueItem(job.id, "failed", 0, reason)));
    throw error;
  }
  return queue;
}

export async function prepareReplay(job: DownloadJob): Promise<void> {
  const origins = new Map<string, Map<string, string>>();
  for (const input of [...job.inputs, ...job.subtitles]) {
    const origin = new URL(input.url).origin;
    const headers = origins.get(origin) ?? new Map<string, string>();
    for (const header of input.headers) {
      const name = header.name.toLowerCase();
      // Ordinary request headers are set by the individual fetch, never by a global rule.
      if (!/^(?:origin|referer)$/.test(name)) continue;
      if (headers.has(name) && headers.get(name) !== header.value) throw new Error("Conflicting source request headers. Download these tracks separately.");
      headers.set(name, header.value);
    }
    if (!headers.has("referer")) headers.set("referer", job.pageUrl);
    origins.set(origin, headers);
  }
  if (origins.size > REPLAY_RULE_LIMIT) throw new Error("Too many media sources.");
  const addRules: chrome.declarativeNetRequest.Rule[] = [...origins].map(([origin, headers], index) => ({
    action: {
      requestHeaders: [...headers].map(([header, value]) => ({ header, value, operation: chrome.declarativeNetRequest.HeaderOperation.SET })),
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      regexFilter: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
    id: REPLAY_RULE_ID + index,
    priority: 1,
  }));
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules,
    removeRuleIds: Array.from({ length: REPLAY_RULE_LIMIT }, (_, index) => REPLAY_RULE_ID + index),
  });
}

export async function releaseReplay(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: Array.from({ length: REPLAY_RULE_LIMIT }, (_, index) => REPLAY_RULE_ID + index) });
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreation) return offscreenCreation;
  offscreenCreation = createOffscreenDocument();
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = undefined;
  }
}

async function createOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL("offscreen/index.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    justification: "Потоковая сборка видео и сохранение большого файла без удержания его в памяти",
    reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
    url: "offscreen/index.html",
  });
}
