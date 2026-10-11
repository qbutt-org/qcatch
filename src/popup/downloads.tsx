import type { QueueItem, QueueSnapshot, QueueStatus } from "../shared/types.ts";
import { itemCount } from "../shared/localization.ts";
import { ErrorNotice, useLanguage } from "./language.tsx";

const FINISHED = new Set<QueueStatus>(["canceled", "completed", "failed"]);
const QUEUE_LABELS = {
  canceled: "Отменено",
  completed: "Готово",
  downloading: "Скачивание",
  failed: "Не удалось скачать",
  preparing: "Ищем поток",
  queued: "В очереди",
  saving: "Сохраняем файл",
} as const;

function QueueRow(props: {
  item: QueueItem;
  onCancel: (jobId: string) => void;
}) {
  const { language, t } = useLanguage();
  const { item } = props;
  const active = !FINISHED.has(item.status);
  const indeterminate = item.status === "preparing" || item.status === "queued";
  const showPercent = item.status === "downloading" || item.status === "saving";
  const subject = item.job.episode
    ? t("Серия {episode}", { episode: item.job.episode })
    : item.job.title;
  const audioSources =
    item.job.yummySources?.filter((source) => source.kind === "audio").length ??
    0;
  const subtitleSources =
    item.job.yummySources?.filter((source) => source.kind === "subtitle")
      .length ?? 0;
  const sourceSummary = item.job.yummySources
    ? [
        audioSources ? itemCount(language, audioSources, "audio") : "",
        subtitleSources
          ? itemCount(language, subtitleSources, "subtitles")
          : "",
      ]
        .filter(Boolean)
        .join(" + ")
    : undefined;
  const metadata = [
    item.job.episode ? item.job.title : "",
    sourceSummary,
    item.job.player,
    item.job.container.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    <article class={`queue-row ${item.status}`}>
      <div class="queue-copy">
        <strong title={subject}>{subject}</strong>
        <span title={metadata}>{metadata}</span>
      </div>
      <div class="queue-state">
        {item.error ? (
          <ErrorNotice message={item.error} />
        ) : (
          <span>{t(QUEUE_LABELS[item.status])}</span>
        )}
        {showPercent && <b>{Math.round(item.progress * 100)}%</b>}
      </div>
      {active && (
        <button
          class="cancel-button"
          type="button"
          onClick={() => props.onCancel(item.job.id)}
        >
          {t("Отменить")}
        </button>
      )}
      {(active || item.status === "completed") && (
        <div class={`progress ${indeterminate ? "indeterminate" : ""}`}>
          <i
            style={{
              width: `${item.status === "completed" ? 100 : Math.round(item.progress * 100)}%`,
            }}
          />
        </div>
      )}
    </article>
  );
}

export function Queue(props: {
  queue: QueueSnapshot;
  onCancel: (jobId: string) => void;
}) {
  const { language, t } = useLanguage();
  if (props.queue.items.length === 0) return null;
  const items = [...props.queue.items].sort(
    (left, right) =>
      right.job.createdAt - left.job.createdAt ||
      (left.job.episode ?? Number.MAX_SAFE_INTEGER) -
        (right.job.episode ?? Number.MAX_SAFE_INTEGER),
  );
  const active = items.filter((item) => !FINISHED.has(item.status)).length;
  return (
    <section class="queue-section">
      <div class="queue-heading">
        <h2>{t("Загрузки")}</h2>
        <span>
          {active > 0
            ? t("{count} в работе", { count: active })
            : itemCount(language, items.length, "files")}
        </span>
      </div>
      <div class="queue-list">
        {items.map((item) => (
          <QueueRow item={item} key={item.job.id} onCancel={props.onCancel} />
        ))}
      </div>
    </section>
  );
}
