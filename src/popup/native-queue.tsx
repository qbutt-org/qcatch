import type { NativeJob } from "../shared/native.ts";
import { timecode } from "../shared/time.ts";
import { itemCount, type Translator } from "../shared/localization.ts";
import { ErrorNotice, useLanguage } from "./language.tsx";

const FINISHED = new Set<NativeJob["status"]>([
  "completed",
  "failed",
  "canceled",
]);

function jobLabel(job: NativeJob, t: Translator): string | undefined {
  if (job.status === "completed") return undefined;
  const labels = {
    queued: "В очереди",
    preparing: "Подготовка…",
    downloading: "Скачивание",
    processing: "Обработка файла…",
    canceling: "Отмена…",
    failed: "Не удалось скачать",
    canceled: "Отменено",
  } as const;
  return t(labels[job.status]);
}

export function NativeQueue(props: {
  jobs: NativeJob[];
  onCancel: (id: string) => void;
  onReveal: (id: string) => void;
}) {
  const { t, language } = useLanguage();
  if (!props.jobs.length) return null;
  let historyCount = 0;
  const visibleJobs = [...props.jobs].reverse().filter((job) => {
    if (!FINISHED.has(job.status)) return true;
    if (historyCount >= 3) return false;
    historyCount += 1;
    return true;
  });
  const activeCount = visibleJobs.length - historyCount;
  return (
    <section class="queue-section youtube-queue">
      <div class="queue-heading">
        <h2>{t("Загрузки")}</h2>
        <span>
          {t(activeCount ? "{count} в работе" : "{count} в списке", {
            count: activeCount || visibleJobs.length,
          })}
        </span>
      </div>
      <div class="queue-list">
        {visibleJobs.map((job) => {
          const active = !FINISHED.has(job.status);
          const progress = Math.round(
            Math.min(1, Math.max(0, job.progress)) * 100,
          );
          const showProgress =
            job.status === "downloading" ||
            (job.status === "processing" && job.progress > 0);
          const indeterminate = active && !showProgress;
          const label = jobLabel(job, t);
          return (
            <article class={`queue-row ${job.status}`} key={job.id}>
              <div class="queue-copy">
                <strong title={job.title}>{job.title}</strong>
                <span>
                  {job.service ?? job.format.toUpperCase()} /{" "}
                  {job.service && job.filenames?.length
                    ? itemCount(language, job.filenames.length, "files")
                    : job.start || job.end !== null
                      ? `${timecode(job.start)} — ${job.end === null ? t("до конца") : timecode(job.end)}`
                      : t("Целиком")}
                </span>
              </div>
              {(job.error || label) && (
                <div class="queue-state">
                  {job.error ? (
                    <ErrorNotice message={job.error} />
                  ) : (
                    <span>{label}</span>
                  )}
                  {showProgress && <b>{progress}%</b>}
                </div>
              )}
              {active && job.status !== "canceling" && (
                <button
                  class="cancel-button"
                  type="button"
                  onClick={() => props.onCancel(job.id)}
                >
                  {t("Отменить")}
                </button>
              )}
              {(job.status === "completed" ||
                Boolean(job.filenames?.length)) && (
                <button
                  class="youtube-text-button youtube-reveal"
                  type="button"
                  onClick={() => props.onReveal(job.id)}
                >
                  {t("Показать")}
                </button>
              )}
              {active && (
                <div class={`progress ${indeterminate ? "indeterminate" : ""}`}>
                  <i style={{ width: `${progress}%` }} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
