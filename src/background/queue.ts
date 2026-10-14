import { EMPTY_QUEUE } from "../shared/types.ts";
import type { DownloadJob, QueueSnapshot, QueueStatus } from "../shared/types.ts";

const QUEUE_KEY = "download-queue";
let pendingMutation: Promise<void> = Promise.resolve();

async function readStoredQueue(): Promise<QueueSnapshot> {
  const stored = await chrome.storage.session.get(QUEUE_KEY);
  const queue = (stored[QUEUE_KEY] as QueueSnapshot | undefined) ?? { ...EMPTY_QUEUE, items: [] };
  const items = queue.items.filter((item) => item.status !== "completed");
  if (items.length === queue.items.length) return queue;
  return { ...queue, items };
}

export async function readQueue(): Promise<QueueSnapshot> {
  await pendingMutation;
  return readStoredQueue();
}

async function writeQueue(queue: QueueSnapshot): Promise<void> {
  await chrome.storage.session.set({ [QUEUE_KEY]: queue });
  void chrome.runtime.sendMessage({ queue, type: "queue:changed" }).catch(() => undefined);
}

function mutateQueue(mutator: (queue: QueueSnapshot) => boolean): Promise<QueueSnapshot> {
  const operation = pendingMutation.then(async () => {
    const queue = await readStoredQueue();
    if (!mutator(queue)) return queue;
    queue.revision += 1;
    await writeQueue(queue);
    return queue;
  });
  pendingMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function addQueueJobs(jobs: DownloadJob[], status: QueueStatus = "queued"): Promise<QueueSnapshot> {
  return mutateQueue((queue) => {
    const known = new Set(queue.items.map((item) => item.job.id));
    let changed = false;
    for (const job of jobs) {
      if (known.has(job.id)) continue;
      queue.items.push({ job, progress: 0, status });
      known.add(job.id);
      changed = true;
    }
    return changed;
  });
}

export async function replaceQueueJob(jobId: string, job: DownloadJob): Promise<QueueSnapshot> {
  return mutateQueue((queue) => {
    const item = queue.items.find((candidate) => candidate.job.id === jobId);
    if (!item || item.status === "canceled") return false;
    item.job = job;
    item.status = "queued";
    item.progress = 0;
    delete item.error;
    return true;
  });
}

export async function queueItemIsActive(jobId: string): Promise<boolean> {
  const queue = await readQueue();
  const item = queue.items.find((candidate) => candidate.job.id === jobId);
  return Boolean(item && !["canceled", "completed", "failed"].includes(item.status));
}

export async function updateQueueItem(
  jobId: string,
  status: QueueStatus,
  progress: number,
  error?: string,
): Promise<QueueSnapshot> {
  return mutateQueue((queue) => {
    const index = queue.items.findIndex((candidate) => candidate.job.id === jobId);
    const item = queue.items[index];
    if (!item || ["canceled", "failed"].includes(item.status)) return false;
    if (status === "completed") {
      queue.items.splice(index, 1);
      return true;
    }
    item.status = status;
    item.progress = Math.max(0, Math.min(1, progress));
    if (error) item.error = error;
    else delete item.error;
    return true;
  });
}
