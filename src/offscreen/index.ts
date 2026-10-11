import { runDownload } from "./download.ts";
import type { DownloadJob, OffscreenMessage, PreparedYummyBatchRequest } from "../shared/types.ts";

const pending: DownloadJob[] = [];
const pendingBatches: Array<{ jobs: DownloadJob[]; request: PreparedYummyBatchRequest }> = [];
const controllers = new Map<string, AbortController>();
let running = false;
let preparing = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length > 0) {
      const job = pending.shift();
      if (!job) continue;
      const controller = new AbortController();
      controllers.set(job.id, controller);
      await runDownload(job, controller.signal);
      controllers.delete(job.id);
    }
  } finally {
    running = false;
  }
}

async function failPreparation(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await chrome.runtime.sendMessage({ jobId, progress: 0, status: "failed", type: "queue:update", error: message });
}

async function drainBatches(): Promise<void> {
  if (preparing) return;
  preparing = true;
  try {
    while (pendingBatches.length > 0) {
      const batch = pendingBatches.shift();
      if (!batch) continue;
      for (const planned of batch.jobs) {
        try {
          const result = await chrome.runtime.sendMessage({
            job: planned,
            request: batch.request,
            type: "yummy:prepare-one",
          }) as { error?: string; job?: DownloadJob } | undefined;
          if (result?.error) throw new Error(result.error);
          if (!result?.job) continue;
          pending.push(result.job);
          void drain();
        } catch (error) {
          await failPreparation(planned.id, error);
        }
      }
    }
  } finally {
    preparing = false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const candidate = message as OffscreenMessage;
  if (candidate.target !== "offscreen") return;
  if (!["offscreen:run", "offscreen:yummy-batch", "offscreen:cancel"].includes(candidate.type)) return;
  if (candidate.type === "offscreen:run") {
    pending.push(candidate.job);
    void drain();
  } else if (candidate.type === "offscreen:yummy-batch") {
    pendingBatches.push({ jobs: candidate.jobs, request: candidate.request });
    void drainBatches();
  } else if (candidate.type === "offscreen:cancel") {
    const index = pending.findIndex((job) => job.id === candidate.jobId);
    if (index >= 0) pending.splice(index, 1);
    controllers.get(candidate.jobId)?.abort();
  }
  sendResponse({ accepted: true });
  return false;
});
