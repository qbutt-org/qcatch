import { useEffect, useState } from "preact/hooks";
import type { NativeHealth } from "../shared/native.ts";
import { ErrorNotice, useLanguage } from "./language.tsx";

export function ProductActions(props: {
  tabId: number;
  sourceId?: string;
  audioIds?: string[];
  subtitleIds?: string[];
  youtube?: boolean;
  currentVideo?: boolean;
}) {
  const { t } = useLanguage();
  const [health, setHealth] = useState<NativeHealth>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    void chrome.runtime
      .sendMessage({ type: "integration:health" })
      .then((value: NativeHealth & { error?: string }) => {
        if (mounted && !value.error) setHealth(value);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const perform = async (action: "play" | "watch" | "download") => {
    setBusy(true);
    setError(undefined);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: action === "play" ? "media:play" : "integration:handoff",
        tabId: props.tabId,
        sourceId: props.sourceId,
        audioIds: props.audioIds ?? [],
        subtitleIds: props.subtitleIds ?? [],
        ...(action === "play" ? {} : { action }),
      })) as { error?: string };
      if (response.error) throw new Error(response.error);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="product-actions">
        {!props.youtube &&
          (health?.qplayInstalled ? (
            <button
              type="button"
              disabled={busy || !props.sourceId}
              onClick={() => void perform("play")}
            >
              {t(
                props.currentVideo
                  ? "Текущее видео в qplay"
                  : "Открыть в qplay",
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                void chrome.tabs.create({
                  url: health
                    ? "https://github.com/qbutt-org/qplay/releases/latest/download/qplay-setup.exe"
                    : "https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe",
                })
              }
            >
              {t(health ? "Установить qplay" : "Установить qcatch для Windows")}
            </button>
          ))}
        {health?.qbuttInstalled && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void perform("watch")}
            >
              {t("Смотреть в qbutt")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void perform("download")}
            >
              {t("Скачать через qbutt")}
            </button>
          </>
        )}
      </div>
      {error && <ErrorNotice message={error} />}
    </>
  );
}
