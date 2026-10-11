import { useEffect, useState } from "preact/hooks";
import type { NativeJob } from "../shared/native.ts";
import { PLATFORM_NAMES, type PlatformReference } from "../shared/platforms.ts";
import type { QueueSnapshot } from "../shared/types.ts";
import { errorTranslation } from "../shared/localization.ts";
import type {
  PlatformMessage,
  PlatformResult,
} from "../background/platforms.ts";
import { ErrorNotice, Header, useLanguage } from "./language.tsx";
import { NativeQueue } from "./native-queue.tsx";
import { Queue } from "./downloads.tsx";

async function request<T>(message: PlatformMessage): Promise<T> {
  const result = (await chrome.runtime.sendMessage(message)) as T & {
    error?: string;
  };
  if (!result)
    throw new Error(
      "The extension did not respond. Reload qcatch in your browser's extensions page and retry.",
    );
  if (result.error) throw new Error(result.error);
  return result;
}

export function PlatformPanel({
  tabId,
  reference,
}: {
  tabId: number;
  reference: PlatformReference;
}) {
  const { t, language } = useLanguage();
  const [jobs, setJobs] = useState<NativeJob[]>([]);
  const [queue, setQueue] = useState<QueueSnapshot>({ items: [], revision: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const next = (await chrome.runtime.sendMessage({
          type: "queue:get",
        })) as QueueSnapshot;
        if (mounted && next) setQueue(next);
        const native = await request<{ jobs: NativeJob[] }>({
          type: "platform:jobs",
        }).catch(() => undefined);
        if (mounted && native) {
          setJobs(native.jobs);
        }
      } catch (error) {
        if (mounted)
          setError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [reference.url]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await request<PlatformResult>({
        type: "platform:run",
        tabId,
        url: reference.url,
      });
      const job = result.job;
      if (result.failure)
        setError(
          `${t("Запущено {count} из {total}.", { count: result.downloads ?? 0, total: result.total ?? 0 })} ${errorTranslation(language, result.failure).message}`,
        );
      if (job)
        setJobs((current) => [
          ...current.filter((existing) => existing.id !== job.id),
          job,
        ]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const operation = async (
    type: "platform:cancel" | "platform:reveal",
    jobId: string,
  ) => {
    try {
      await request({ type, jobId });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <main class="shell">
      <Header />
      <section class="page-heading">
        <h1>{PLATFORM_NAMES[reference.service]}</h1>
      </section>
      <div class="download-actions">
        <button
          class="primary"
          type="button"
          disabled={busy}
          onClick={() => void run()}
        >
          {t(
            busy
              ? "Подготавливаем…"
              : reference.kind === "live"
                ? "Открыть эфир в qplay"
                : reference.kind === "track"
                  ? "Скачать трек"
                  : "Скачать медиа",
          )}
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {(error?.includes("Локальный помощник не отвечает.") ||
        error?.includes("версия помощника несовместима")) && (
        <button
          type="button"
          onClick={() =>
            void chrome.tabs.create({
              url: "https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe",
            })
          }
        >
          {t("Установить qcatch для Windows")}
        </button>
      )}
      {error?.includes("qplay is not installed") && (
        <button
          type="button"
          onClick={() =>
            void chrome.tabs.create({
              url: "https://github.com/qbutt-org/qplay/releases/latest/download/qplay-setup.exe",
            })
          }
        >
          {t("Установить qplay")}
        </button>
      )}
      <NativeQueue
        jobs={jobs}
        onCancel={(id) => void operation("platform:cancel", id)}
        onReveal={(id) => void operation("platform:reveal", id)}
      />
      <Queue
        queue={queue}
        onCancel={(jobId) =>
          void chrome.runtime.sendMessage({ type: "queue:cancel", jobId })
        }
      />
    </main>
  );
}
