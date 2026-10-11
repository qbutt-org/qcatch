import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
} from "@floating-ui/dom";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  CapturedResource,
  YummyContext,
  YummySource,
} from "../shared/types.ts";
import { yummySourceKey } from "../shared/yummy.ts";
import { useLanguage } from "./language.tsx";

export function fileSize(bytes: number, language: "ru" | "en"): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(1)} ${language === "ru" ? "ГБ" : "GB"}`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} ${language === "ru" ? "МБ" : "MB"}`;
}

function trackLabel(resource: CapturedResource): string {
  if (resource.name) return resource.name;
  try {
    return decodeURIComponent(
      new URL(resource.url).pathname.split("/").pop() ?? resource.kind,
    );
  } catch {
    return resource.kind;
  }
}

export function ToggleList(props: {
  onChange: (ids: Set<string>) => void;
  resources: CapturedResource[];
  selected: Set<string>;
  title: string;
}) {
  if (props.resources.length === 0) return null;
  return (
    <details class="tracks" open={props.resources.length <= 2}>
      <summary>
        <span>{props.title}</span>
        <b>
          {props.selected.size}/{props.resources.length}
        </b>
      </summary>
      <div class="track-list">
        {props.resources.map((resource) => (
          <label class="check-row" key={resource.id}>
            <input
              type="checkbox"
              checked={props.selected.has(resource.id)}
              onChange={() => {
                const next = new Set(props.selected);
                if (next.has(resource.id)) next.delete(resource.id);
                else next.add(resource.id);
                props.onChange(next);
              }}
            />
            <span title={trackLabel(resource)}>{trackLabel(resource)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

export function YummySourcePicker(props: {
  estimating: boolean;
  onChange: (keys: Set<string>) => void;
  selected: Set<string>;
  sizeByKey: ReadonlyMap<string, number>;
  sources: YummySource[];
  title: string;
}) {
  const { language, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedCount = props.sources.filter((source) =>
    props.selected.has(yummySourceKey(source)),
  ).length;
  const selectedBytes = props.sources.reduce((total, source) => {
    const key = yummySourceKey(source);
    return (
      total + (props.selected.has(key) ? (props.sizeByKey.get(key) ?? 0) : 0)
    );
  }, 0);
  const selection =
    selectedCount === props.sources.length
      ? t("Все {count}", { count: props.sources.length })
      : t("{selected} из {total}", {
          selected: selectedCount,
          total: props.sources.length,
        });

  useEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    const update = async () => {
      const position = await computePosition(trigger, panel, {
        middleware: [
          offset(6),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, elements }) {
              elements.floating.style.maxHeight = `${availableHeight}px`;
              elements.floating.style.width = `${Math.min(availableWidth, Math.max(260, elements.reference.getBoundingClientRect().width))}px`;
            },
          }),
        ],
        placement: "bottom-start",
        strategy: "fixed",
      });
      Object.assign(panel.style, {
        left: `${position.x}px`,
        top: `${position.y}px`,
      });
    };
    const cleanup = autoUpdate(trigger, panel, () => void update());
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.contains(target) && !panel.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cleanup();
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (props.sources.length === 0) return null;

  return (
    <div class="source-picker">
      <span class="control-label">{props.title}</span>
      <button
        aria-expanded={open}
        class="source-trigger"
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selection}</span>
        <small>
          {selectedBytes > 0
            ? `≈ ${fileSize(selectedBytes, language)}`
            : props.estimating
              ? t("Считаем…")
              : ""}
        </small>
        <i />
      </button>
      {open && (
        <div
          class="source-popover"
          ref={panelRef}
          role="listbox"
          aria-multiselectable="true"
        >
          <div class="source-picker-actions">
            <button
              type="button"
              onClick={() =>
                props.onChange(
                  new Set([
                    ...props.selected,
                    ...props.sources.map(yummySourceKey),
                  ]),
                )
              }
            >
              {t("Все")}
            </button>
            <button
              type="button"
              onClick={() =>
                props.onChange(
                  new Set(
                    [...props.selected].filter(
                      (key) =>
                        !props.sources.some(
                          (source) => yummySourceKey(source) === key,
                        ),
                    ),
                  ),
                )
              }
            >
              {t("Снять")}
            </button>
          </div>
          <div class="source-picker-list">
            {props.sources.map((source) => {
              const key = yummySourceKey(source);
              return (
                <label class="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={props.selected.has(key)}
                    onChange={() => {
                      const next = new Set(props.selected);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      props.onChange(next);
                    }}
                  />
                  <span>
                    {source.name}
                    <small>
                      {props.sizeByKey.get(key)
                        ? `≈ +${fileSize(props.sizeByKey.get(key)!, language)}`
                        : props.estimating
                          ? "…"
                          : ""}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function EpisodePicker(props: {
  context: YummyContext;
  onChange: (episodes: Set<number>) => void;
  selected: Set<number>;
}) {
  const { t } = useLanguage();
  const available = props.context.episodes.available;
  return (
    <section class="episode-section">
      <div class="section-heading">
        <strong>{t("Серии")}</strong>
        <div class="selection-actions">
          <span>
            {t("{selected} из {total}", {
              selected: props.selected.size,
              total: available.length,
            })}
          </span>
          <button
            class="text-button"
            type="button"
            onClick={() =>
              props.onChange(
                props.selected.size === available.length
                  ? new Set()
                  : new Set(available),
              )
            }
          >
            {t(props.selected.size === available.length ? "Снять" : "Все")}
          </button>
        </div>
      </div>
      <div class="episode-grid">
        {available.map((episode) => (
          <button
            class={props.selected.has(episode) ? "selected" : ""}
            key={episode}
            type="button"
            aria-pressed={props.selected.has(episode)}
            onClick={() => {
              const next = new Set(props.selected);
              if (next.has(episode)) next.delete(episode);
              else next.add(episode);
              props.onChange(next);
            }}
          >
            {episode}
          </button>
        ))}
      </div>
    </section>
  );
}
