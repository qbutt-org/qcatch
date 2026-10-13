import { NativeQueue } from "./native-queue.tsx";
import { timecode } from "../shared/time.ts";
import type { NativeHealth, NativeJob } from "../shared/native.ts";
import { useEffect, useState } from "preact/hooks";
import { ProductActions } from "./products.tsx";
import { ErrorNotice, Header, useLanguage } from "./language.tsx";
import type {
  YoutubeInfoState,
  YoutubeMessage,
  YoutubeSelection,
} from "../shared/youtube.ts";

const FINISHED = new Set<NativeJob["status"]>([
  "completed",
  "failed",
  "canceled",
]);

async function request<T>(message: YoutubeMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as
    T | { error: string };
  if (response == null && message.type !== "youtube:selection:get") {
    throw new Error(
      "Нет ответа от фоновой части расширения. Нажмите «Обновить» на карточке qcatch в списке расширений и откройте popup заново.",
    );
  }
  if (
    response &&
    typeof response === "object" &&
    "error" in response &&
    typeof response.error === "string"
  )
    throw new Error(response.error);
  return response as T;
}

function parseTimecode(value: string): number | undefined {
  const text = value.trim().replace(",", ".");
  if (!/^\d+(?::[0-5]?\d){0,2}(?:\.\d{1,3})?$/.test(text)) return undefined;
  const seconds = text
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function YoutubePanel({
  tabId,
  url,
  music,
}: {
  tabId: number;
  url: string;
  music: boolean;
}) {
  const { t } = useLanguage();
  const [health, setHealth] = useState<NativeHealth>();
  const [connectionError, setConnectionError] = useState<string>();
  const [video, setVideo] = useState<YoutubeInfoState>({ status: "loading" });
  const [selection, setSelection] = useState<YoutubeSelection>();
  const [startText, setStartText] = useState("00:00");
  const [endText, setEndText] = useState("");
  const [jobs, setJobs] = useState<NativeJob[]>([]);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let mounted = true;
    void request<YoutubeSelection | undefined>({
      type: "youtube:selection:get",
      tabId,
      url,
    })
      .then((saved) => {
        if (!mounted) return;
        const initial = saved ?? {
          format: music ? "mp3" : "mp4",
          start: 0,
          end: null,
        };
        setSelection(initial);
        setStartText(timecode(initial.start));
        if (initial.end !== null) setEndText(timecode(initial.end));
      })
      .catch(() => {
        if (mounted) {
          setSelection({ format: music ? "mp3" : "mp4", start: 0, end: null });
          setNotice(
            "Не удалось восстановить выбор. Проверьте формат и время перед скачиванием.",
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, [tabId, url, music]);

  useEffect(() => {
    if (selection)
      void request({
        type: "youtube:selection:set",
        tabId,
        url,
        selection,
      }).catch(() => {
        setNotice(
          "Не удалось сохранить выбор. Оставьте это окно открытым до начала скачивания.",
        );
      });
  }, [tabId, url, selection]);

  useEffect(() => {
    let mounted = true;
    let timer: number | undefined;
    let retryInfo = retry > 0;
    setVideo({ status: "loading" });

    const refresh = async () => {
      const [nextHealth, nextJobs] = await Promise.allSettled([
        request<NativeHealth>({ type: "youtube:health" }),
        request<{ jobs: NativeJob[] }>({ type: "youtube:jobs" }),
      ]);
      if (!mounted) return;
      if (nextJobs.status === "fulfilled") setJobs(nextJobs.value.jobs);
      else if (nextHealth.status === "fulfilled")
        setNotice(
          "Не удалось обновить список загрузок. Проверьте приложение qcatch на компьютере.",
        );
      if (nextHealth.status === "rejected") {
        setVideo({ status: "loading" });
        setHealth(undefined);
        setConnectionError(
          nextHealth.reason instanceof Error
            ? nextHealth.reason.message
            : String(nextHealth.reason),
        );
      } else {
        setHealth(nextHealth.value);
        setConnectionError(undefined);
        if (nextHealth.value.tools.status === "ready") {
          const retryRequest = retryInfo;
          retryInfo = false;
          try {
            const nextVideo = await request<YoutubeInfoState>({
              type: "youtube:info",
              url,
              ...(retryRequest ? { retry: true } : {}),
            });
            if (!mounted) return;
            setVideo(nextVideo);
          } catch (error) {
            if (!mounted) return;
            setVideo({
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (mounted) timer = window.setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [url, retry]);

  const info = video.info;
  const duration = info?.duration ?? 0;
  useEffect(() => {
    if (duration > 0 && selection?.end === null) setEndText(timecode(duration));
  }, [duration, selection?.end]);

  const start = parseTimecode(startText);
  const end = parseTimecode(endText);
  const rangeError = !info
    ? undefined
    : start === undefined || end === undefined
      ? t("Укажите время в формате 00:00 или 0:00:00.")
      : start >= end
        ? t("Начало должно быть раньше конца.")
        : end > duration
          ? t("Конец не может быть позже {duration}.", {
              duration: timecode(duration),
            })
          : undefined;
  const rangeStart = Math.max(
    0,
    Math.min(
      duration,
      !rangeError && start !== undefined ? start : (selection?.start ?? 0),
    ),
  );
  const rangeEnd = Math.max(
    rangeStart,
    Math.min(
      duration,
      !rangeError && end !== undefined ? end : (selection?.end ?? duration),
    ),
  );
  const whole = selection?.start === 0 && selection.end === null;
  const matchingJob =
    selection &&
    jobs.some(
      (job) =>
        !FINISHED.has(job.status) &&
        job.url === url &&
        job.format === selection.format &&
        job.start === selection.start &&
        job.end === selection.end,
    );
  const canDownload = Boolean(
    info &&
    selection &&
    !rangeError &&
    !connectionError &&
    health?.tools.status === "ready" &&
    !busy &&
    !matchingJob,
  );

  const selectRange = (nextStart: number, nextEnd: number) => {
    if (!selection) return;
    setStartText(timecode(nextStart));
    setEndText(timecode(nextEnd));
    setSelection({
      ...selection,
      start: nextStart,
      end: nextEnd === duration ? null : nextEnd,
    });
  };

  const editTime = (field: "start" | "end", value: string) => {
    if (field === "start") setStartText(value);
    else setEndText(value);
    const nextStart = parseTimecode(field === "start" ? value : startText);
    const nextEnd = parseTimecode(field === "end" ? value : endText);
    if (
      selection &&
      nextStart !== undefined &&
      nextEnd !== undefined &&
      nextStart < nextEnd &&
      nextEnd <= duration
    ) {
      setSelection({
        ...selection,
        start: nextStart,
        end: nextEnd === duration ? null : nextEnd,
      });
    }
  };

  const download = async () => {
    if (!canDownload || !selection) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const job = await request<NativeJob>({
        type: "youtube:download",
        url,
        selection,
      });
      setJobs((current) => [
        ...current.filter((item) => item.id !== job.id),
        job,
      ]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const queueAction = async (
    type: "youtube:cancel" | "youtube:reveal",
    jobId: string,
  ) => {
    setNotice(undefined);
    try {
      const result = await request<NativeJob | { ok: true }>({ type, jobId });
      if ("id" in result)
        setJobs((current) =>
          current.map((job) => (job.id === result.id ? result : job)),
        );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const retryTools = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      setHealth(await request<NativeHealth>({ type: "youtube:retry-tools" }));
      setRetry((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="shell youtube-shell">
      <Header />

      {connectionError ? (
        <section class="empty-state youtube-setup">
          <h1>{t("Нужно приложение на компьютере")}</h1>
          <p>{t("Установите или запустите qcatch для Windows.")}</p>
          <button
            class="primary"
            type="button"
            onClick={() =>
              void chrome.tabs.create({
                url: "https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe",
              })
            }
          >
            {t("Скачать приложение")}
          </button>
          <details>
            <summary>{t("Подробности подключения")}</summary>
            <ErrorNotice message={connectionError} />
          </details>
        </section>
      ) : health?.tools.status === "error" ? (
        <section class="empty-state youtube-setup">
          <h1>{t("Не удалось подготовить загрузку")}</h1>
          <ErrorNotice
            message={
              health.tools.error ??
              "Проверьте подключение к интернету и попробуйте снова."
            }
          />
          <button
            class="youtube-text-button"
            type="button"
            disabled={busy}
            onClick={() => void retryTools()}
          >
            {t(busy ? "Подготавливаем…" : "Попробовать снова")}
          </button>
        </section>
      ) : !health || health.tools.status === "checking" ? (
        <section class="empty-state loading">
          <h1>{t(health ? "Готовим загрузку" : "Подключаемся")}</h1>
          {health && (
            <p>{t("При первом запуске подготовка займёт немного времени.")}</p>
          )}
          <i />
        </section>
      ) : video.status === "failed" ? (
        <section class="empty-state youtube-setup">
          <h1>
            {t(music ? "Не удалось открыть трек" : "Не удалось открыть видео")}
          </h1>
          <ErrorNotice
            message={
              video.error ??
              "Проверьте, что страница доступна, и попробуйте снова."
            }
          />
          <button
            class="youtube-text-button"
            type="button"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("Попробовать снова")}
          </button>
        </section>
      ) : !info || !selection ? (
        <section class="empty-state loading">
          <h1>{t(music ? "Открываем трек" : "Открываем видео")}</h1>
          <i />
        </section>
      ) : (
        <section class="youtube-download">
          <div class="youtube-media">
            {info.thumbnail && <img src={info.thumbnail} alt="" />}
            <div class="page-heading">
              <h1 title={info.title}>{info.title}</h1>
              <p>
                {[info.channel, timecode(duration)].filter(Boolean).join(" / ")}
              </p>
            </div>
          </div>

          <section class="youtube-range">
            <div class="section-heading">
              <strong>
                {t(
                  whole && !rangeError
                    ? music
                      ? "Трек целиком"
                      : "Видео целиком"
                    : "Фрагмент",
                )}
              </strong>
              <button
                class="youtube-text-button"
                type="button"
                disabled={whole && !rangeError}
                onClick={() => selectRange(0, duration)}
              >
                {t("Целиком")}
              </button>
            </div>
            <div class="youtube-slider">
              <div class="youtube-slider-track">
                <i
                  style={{
                    left: `${(rangeStart / duration) * 100}%`,
                    right: `${100 - (rangeEnd / duration) * 100}%`,
                  }}
                />
              </div>
              <input
                aria-label={t("Начало фрагмента")}
                type="range"
                min="0"
                max={duration}
                step="0.1"
                value={rangeStart}
                onInput={(event) =>
                  selectRange(
                    Math.min(
                      Number(event.currentTarget.value),
                      Math.max(0, rangeEnd - 0.1),
                    ),
                    rangeEnd,
                  )
                }
              />
              <input
                aria-label={t("Конец фрагмента")}
                type="range"
                min="0"
                max={duration}
                step="0.1"
                value={rangeEnd}
                onInput={(event) =>
                  selectRange(
                    rangeStart,
                    Math.max(
                      Number(event.currentTarget.value),
                      Math.min(duration, rangeStart + 0.1),
                    ),
                  )
                }
              />
            </div>
            <div class="youtube-time-fields">
              <label class="field">
                <span>{t("Начало")}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={startText}
                  placeholder="00:00"
                  spellcheck={false}
                  onInput={(event) =>
                    editTime("start", event.currentTarget.value)
                  }
                  onBlur={() => {
                    if (start !== undefined) setStartText(timecode(start));
                  }}
                />
              </label>
              <label class="field">
                <span>{t("Конец")}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={endText}
                  placeholder="00:00"
                  spellcheck={false}
                  onInput={(event) =>
                    editTime("end", event.currentTarget.value)
                  }
                  onBlur={() => {
                    if (end !== undefined) setEndText(timecode(end));
                  }}
                />
              </label>
              <span class="youtube-duration">
                {!rangeError && start !== undefined && end !== undefined
                  ? t("{duration} к загрузке", {
                      duration: timecode(end - start),
                    })
                  : ""}
              </span>
            </div>
            {rangeError && <p class="notice error">{rangeError}</p>}
          </section>

          <div class="youtube-format">
            <div class="segmented">
              <button
                class={selection.format === "mp4" ? "selected" : ""}
                type="button"
                aria-pressed={selection.format === "mp4"}
                onClick={() => setSelection({ ...selection, format: "mp4" })}
              >
                {t("Видео / MP4")}
              </button>
              <button
                class={selection.format === "mp3" ? "selected" : ""}
                type="button"
                aria-pressed={selection.format === "mp3"}
                onClick={() => setSelection({ ...selection, format: "mp3" })}
              >
                {t("Аудио / MP3")}
              </button>
            </div>
          </div>
          <div class="youtube-download-action">
            <button
              class="primary"
              type="button"
              disabled={!canDownload}
              onClick={() => void download()}
            >
              {t(
                busy ? "Добавляем…" : matchingJob ? "Уже в очереди" : "Скачать",
              )}
            </button>
          </div>
        </section>
      )}
      {!connectionError && <ProductActions tabId={tabId} pageUrl={url} youtube />}
      {notice && <ErrorNotice message={notice} />}
      <NativeQueue
        jobs={jobs}
        onCancel={(id) => void queueAction("youtube:cancel", id)}
        onReveal={(id) => void queueAction("youtube:reveal", id)}
      />
    </main>
  );
}
