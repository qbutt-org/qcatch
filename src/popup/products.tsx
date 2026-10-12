import { useEffect, useState } from "preact/hooks";
import type { NativeHealth } from "../shared/native.ts";
import { NATIVE_BRIDGE_PROTOCOL } from "../shared/native.ts";
import { productActionKey, type ProductAction, type ProductActionKind } from "../shared/integration.ts";
import { ErrorNotice, useLanguage } from "./language.tsx";

export function ProductActions(props: {
  tabId: number;
  pageUrl: string;
  sourceId?: string;
  audioIds?: string[];
  subtitleIds?: string[];
  youtube?: boolean;
}) {
  const { t } = useLanguage();
  const [health, setHealth] = useState<NativeHealth>();
  const [checking, setChecking] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [actions, setActions] = useState<ProductAction[]>([]);
  const [healthError, setHealthError] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const selection = {
    tabId: props.tabId,
    pageUrl: props.pageUrl,
    ...(props.sourceId ? { sourceId: props.sourceId } : {}),
    audioIds: props.audioIds ?? [],
    subtitleIds: props.subtitleIds ?? [],
  };

  useEffect(() => {
    let mounted = true;
    setChecking(true);
    void chrome.runtime.sendMessage({ type: "integration:health" })
      .then((value: NativeHealth & { error?: string }) => {
        if (value.error) throw new Error(value.error);
        if (value.protocol !== NATIVE_BRIDGE_PROTOCOL) {
          throw new Error("Обновите qcatch: версия помощника несовместима с расширением.");
        }
        if (mounted) {
          setHealth(value);
          setHealthError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setHealth(undefined);
          setHealthError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, [refresh]);

  useEffect(() => {
    const reload = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, []);

  useEffect(() => {
    let mounted = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void chrome.runtime.sendMessage({ type: "integration:state", tabId: props.tabId })
        .then((value: ProductAction[] | { error: string }) => {
          if (!Array.isArray(value)) throw new Error(value.error);
          if (mounted && current === generation) setActions(value);
        })
        .catch((error: unknown) => {
          if (mounted && current === generation) {
            setConnectionError(error instanceof Error ? error.message : String(error));
          }
        });
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes[`product-actions:${props.tabId}`]) load();
    };
    load();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [props.tabId]);

  const pending = actions.find((action) => action.status === "preparing" || action.status === "sending");
  const current = (kind: ProductActionKind) => actions.findLast((action) => action.key === productActionKey(kind, selection));
  const blocked = (kind: ProductActionKind) => {
    const action = current(kind);
    return Boolean(pending || action?.status === "uncertain"
      || !props.youtube && !props.sourceId
      || props.youtube && kind === "play" && health?.tools.status !== "ready");
  };
  const latest = actions.findLast((action) => action.key === productActionKey(action.action, selection));
  const error = latest?.error ?? connectionError ?? healthError;

  const perform = (action: ProductActionKind) => {
    const previous = current(action);
    setConnectionError(undefined);
    setRefresh((value) => value + 1);
    void chrome.runtime.sendMessage({
      ...selection,
      type: action === "play" ? "media:play" : "integration:handoff",
      ...(action === "play" ? {} : { action }),
      ...(previous ? { previousId: previous.id } : {}),
    }).then((value: ProductAction | { error: string }) => {
      if ("error" in value && !("status" in value)) throw new Error(value.error);
    }).catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : String(error));
    });
  };

  const install = (product: "qplay" | "qcatch" | "qbutt") => {
    void chrome.tabs.create({
      url: product === "qbutt"
        ? "https://qbutt-org.github.io/qbutt/"
        : `https://github.com/qbutt-org/${product}/releases/latest/download/${product}-setup.exe`,
    });
  };

  return (
    <>
      <div class="product-actions">
        {health?.qplayInstalled && (
          <button type="button" disabled={blocked("play")} onClick={() => perform("play")}>
            {current("play")?.status === "sent" ? t("Снова открыть в qplay")
              : t("Открыть в qplay")}
          </button>
        )}
        {!checking && !health?.qplayInstalled && (
          <button type="button" onClick={() => install(health ? "qplay" : "qcatch")}>
            {t(health ? "Установить qplay" : "Установить qcatch для Windows")}
          </button>
        )}
        {health?.qbuttInstalled && (
          <>
            <button type="button" disabled={blocked("watch")} onClick={() => perform("watch")}>
              {current("watch")?.status === "sent" ? t("Снова смотреть в qbutt") : t("Смотреть в qbutt")}
            </button>
            <button type="button" disabled={blocked("download")} onClick={() => perform("download")}>
              {current("download")?.status === "sent" ? t("Снова скачать через qbutt") : t("Скачать через qbutt")}
            </button>
          </>
        )}
        {health && !health.qbuttInstalled && (
          <button type="button" onClick={() => install("qbutt")}>{t("Установить qbutt")}</button>
        )}
        {!checking && !health && (
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>{t("Проверить подключение")}</button>
        )}
      </div>
      {pending && (
        <p class="product-status" role="status">
          {t(pending.action === "play" ? "Открываем qplay…" : "Передаём в qbutt…")}
        </p>
      )}
      {error && <ErrorNotice message={error} />}
    </>
  );
}
