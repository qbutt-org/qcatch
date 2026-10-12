import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  bestResource,
  buildCurrentJob,
  compareResources,
} from "../shared/jobs.ts";
import type {
  CapturedResource,
  Container,
  PopupPreferences,
  QueueSnapshot,
  TabState,
  YummyBatchResult,
  YummyCatalog,
  YummyContext,
  YummyEstimate,
} from "../shared/types.ts";
import { yummySourceKey } from "../shared/yummy.ts";
import { youtubeVideoUrl } from "../shared/youtube.ts";
import { YoutubePanel } from "./youtube.tsx";
import { PlatformPanel } from "./platform.tsx";
import { platformReference } from "../shared/platforms.ts";
import { Queue } from "./downloads.tsx";
import {
  EpisodePicker,
  fileSize,
  ToggleList,
  YummySourcePicker,
} from "./selection.tsx";
import { ProductActions } from "./products.tsx";
import { itemCount } from "../shared/localization.ts";
import {
  ErrorNotice,
  Header,
  LanguageProvider,
  useLanguage,
} from "./language.tsx";

const EMPTY_QUEUE: QueueSnapshot = { items: [], revision: 0 };

if (!chrome.extension.getViews({ type: "popup" }).includes(window)) {
  document.documentElement.classList.add("full-page");
}

function quality(resource: CapturedResource): string {
  const resolution = resource.url.match(
    /(?:^|[/_.-])(2160|1440|1080|720|576|480|360)(?:p|[/_.-]|$)/i,
  )?.[1];
  if (resolution) return `${resolution}p`;
  if (resource.body?.includes("#EXT-X-STREAM-INF")) return "HLS max";
  if (resource.kind === "dash") return "DASH max";
  return resource.kind.toUpperCase();
}

function providerName(resource: CapturedResource, fallback: string): string {
  if (resource.provider === "alloha") return "Alloha";
  if (resource.provider === "cdnvideohub") return "CDNVideoHub";
  if (resource.provider === "kodik") return "Kodik";
  try {
    return new URL(resource.url).hostname.replace(/^www\./, "");
  } catch {
    return fallback;
  }
}

function UniversalApp() {
  const { language, t } = useLanguage();
  const [state, setState] = useState<TabState>();
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE);
  const [tabId, setTabId] = useState<number>();
  const [sourceId, setSourceId] = useState("");
  const [audioIds, setAudioIds] = useState<Set<string>>(new Set());
  const [audioTouched, setAudioTouched] = useState(false);
  const [subtitleIds, setSubtitleIds] = useState<Set<string>>(new Set());
  const [subtitlesTouched, setSubtitlesTouched] = useState(false);
  const [container, setContainer] = useState<Container>("mkv");
  const [yummy, setYummy] = useState<YummyContext>();
  const [yummySourceKeys, setYummySourceKeys] = useState<Set<string>>(
    new Set(),
  );
  const [yummySourcesTouched, setYummySourcesTouched] = useState(false);
  const [yummyEstimate, setYummyEstimate] = useState<YummyEstimate>();
  const [estimating, setEstimating] = useState(false);
  const [loadingPlayer, setLoadingPlayer] = useState(false);
  const estimateVersion = useRef(0);
  const [episodes, setEpisodes] = useState<Set<number>>(new Set());
  const [episodesTouched, setEpisodesTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string>();

  const primary = useMemo(
    () =>
      (state?.resources ?? [])
        .filter((resource) =>
          ["dash", "hls", "video", "audio"].includes(resource.kind),
        )
        .sort(compareResources),
    [state?.revision],
  );
  const audio = useMemo(
    () =>
      (state?.resources ?? []).filter((resource) => resource.kind === "audio"),
    [state?.revision],
  );
  const subtitles = useMemo(
    () =>
      (state?.resources ?? []).filter(
        (resource) => resource.kind === "subtitle",
      ),
    [state?.revision],
  );
  const yummySourceSignature =
    yummy?.sources.map(yummySourceKey).join("\u0001") ?? "";
  const frames = [...new Set(primary.map((resource) => resource.frameId))].sort((left, right) => left - right);

  useEffect(() => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (tab?.id === undefined) return;
        setTabId(tab.id);
        const [nextState, nextQueue] = await Promise.all([
          chrome.runtime.sendMessage({
            tabId: tab.id,
            type: "state:get",
          }) as Promise<TabState>,
          chrome.runtime.sendMessage({
            type: "queue:get",
          }) as Promise<QueueSnapshot>,
        ]);
        const preferences = (await chrome.runtime.sendMessage({
          pageUrl: nextState.page.url,
          tabId: tab.id,
          type: "preferences:get",
        })) as PopupPreferences | undefined;
        setState(nextState);
        setQueue(nextQueue);
        setContainer(preferences?.container ?? "mkv");

        const best = bestResource(nextState.resources);
        const preferredSource = preferences?.sourceId;
        setSourceId(
          preferredSource &&
            nextState.resources.some(
              (resource) => resource.id === preferredSource,
            )
            ? preferredSource
            : (best?.id ?? ""),
        );
        const nextAudio = nextState.resources.filter(
          (resource) => resource.kind === "audio",
        );
        const nextSubtitles = nextState.resources.filter(
          (resource) => resource.kind === "subtitle",
        );
        const restoreAudio = preferences?.audioSelectionTouched === true;
        const restoreSubtitles = preferences?.subtitleSelectionTouched === true;
        setAudioIds(
          new Set(
            restoreAudio
              ? preferences.audioIds.filter((id) =>
                  nextAudio.some((resource) => resource.id === id),
                )
              : nextAudio.map((resource) => resource.id),
          ),
        );
        setSubtitleIds(
          new Set(
            restoreSubtitles
              ? preferences.subtitleIds.filter((id) =>
                  nextSubtitles.some((resource) => resource.id === id),
                )
              : nextSubtitles.map((resource) => resource.id),
          ),
        );
        setAudioTouched(restoreAudio);
        setSubtitlesTouched(restoreSubtitles);

        if (nextState.page.yummy) {
          const discovered = (await chrome.runtime.sendMessage({
            tabId: tab.id,
            type: "yummy:options",
          })) as (YummyContext & { error?: string }) | undefined;
          let context =
            discovered && !("error" in discovered)
              ? discovered
              : nextState.page.yummy;
          const preferredPlayer = preferences?.yummy?.player;
          if (
            preferredPlayer &&
            preferredPlayer !== context.player &&
            context.playerOptions.includes(preferredPlayer)
          ) {
            const catalog = (await chrome.runtime
              .sendMessage({
                player: preferredPlayer,
                tabId: tab.id,
                type: "yummy:catalog",
              })
              .catch(() => undefined)) as
              (YummyCatalog & { error?: string }) | undefined;
            if (catalog && !catalog.error) context = catalog.context;
          }
          setYummy(context);
          const sourceKeys = context.sources.map(yummySourceKey);
          const restoreSources =
            preferences?.yummy?.player === context.player &&
            preferences.yummy.sourcesTouched === true;
          setYummySourceKeys(
            new Set(
              restoreSources
                ? preferences.yummy?.sourceKeys?.filter((key) =>
                    sourceKeys.includes(key),
                  )
                : sourceKeys,
            ),
          );
          setYummySourcesTouched(restoreSources);
          const available = new Set(context.episodes.available);
          const preferredYummy = preferences?.yummy;
          const restoreEpisodes = preferredYummy?.episodesTouched === true;
          setEpisodes(
            new Set(
              restoreEpisodes
                ? preferredYummy.episodes.filter((episode) =>
                    available.has(episode),
                  )
                : [
                    available.has(context.episode)
                      ? context.episode
                      : (context.episodes.available[0] ?? context.episode),
                  ],
            ),
          );
          setEpisodesTouched(restoreEpisodes);
        }
        setReady(true);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
        setReady(true);
      });
  }, []);

  useEffect(() => {
    if (!state) return;
    const best = bestResource(state.resources);
    if (
      !sourceId ||
      !state.resources.some((resource) => resource.id === sourceId)
    )
      setSourceId(best?.id ?? "");
    if (!audioTouched)
      setAudioIds(new Set(audio.map((resource) => resource.id)));
    if (!subtitlesTouched)
      setSubtitleIds(new Set(subtitles.map((resource) => resource.id)));
  }, [state?.revision, audioTouched, subtitlesTouched]);

  useEffect(() => {
    if (!ready || !state || tabId === undefined) return;
    const preferences: PopupPreferences = {
      audioIds: [...audioIds],
      audioSelectionTouched: audioTouched,
      container,
      pageUrl: state.page.url,
      sourceId,
      subtitleIds: [...subtitleIds],
      subtitleSelectionTouched: subtitlesTouched,
      ...(yummy
        ? {
            yummy: {
              episodes: [...episodes].sort((a, b) => a - b),
              episodesTouched,
              player: yummy.player,
              sourceKeys: [...yummySourceKeys],
              sourcesTouched: yummySourcesTouched,
            },
          }
        : {}),
    };
    void chrome.runtime
      .sendMessage({ preferences, tabId, type: "preferences:set" })
      .catch(() => undefined);
  }, [
    ready,
    state?.page.url,
    tabId,
    sourceId,
    audioIds,
    audioTouched,
    subtitleIds,
    subtitlesTouched,
    container,
    yummy?.player,
    yummySourceKeys,
    yummySourcesTouched,
    episodes,
    episodesTouched,
  ]);

  useEffect(() => {
    if (tabId === undefined) return;
    const listener = (message: unknown) => {
      const update = message as {
        pageUrl?: string;
        queue?: QueueSnapshot;
        tabId?: number;
        type?: string;
      };
      if (update.type === "queue:changed" && update.queue)
        setQueue(update.queue);
      if (
        (update.type === "state:reset" || update.type === "state:updated") &&
        update.tabId === tabId
      ) {
        if (
          state &&
          update.pageUrl !== undefined &&
          update.pageUrl !== state.page.url
        ) {
          setReady(false);
          setYummy(undefined);
          setEpisodes(new Set());
          setYummySourceKeys(new Set());
          window.location.reload();
          return;
        }
        void chrome.runtime
          .sendMessage({ tabId, type: "state:get" })
          .then(setState);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [state?.page.url, tabId]);

  useEffect(() => {
    const version = ++estimateVersion.current;
    if (!ready || !yummy || tabId === undefined) return;
    const selectedEpisodes = [...episodes].sort((left, right) => left - right);
    if (yummy.sources.length === 0 || selectedEpisodes.length === 0) {
      setEstimating(false);
      setYummyEstimate(undefined);
      return;
    }
    setEstimating(true);
    setYummyEstimate(undefined);
    const timer = window.setTimeout(() => {
      void chrome.runtime
        .sendMessage({
          request: {
            container: "mkv",
            context: yummy,
            episodes: selectedEpisodes,
            pageUrl: state?.page.url ?? "",
            selectedSources: yummy.sources,
            tabId,
          },
          type: "yummy:estimate",
        })
        .then((estimate: YummyEstimate & { error?: string }) => {
          if (
            estimateVersion.current === version &&
            !estimate.error &&
            Array.isArray(estimate.tracks)
          ) {
            setYummyEstimate(estimate);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (estimateVersion.current === version) setEstimating(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    ready,
    state?.page.url,
    tabId,
    yummy?.player,
    yummySourceSignature,
    episodes,
  ]);

  const selectYummyPlayer = async (player: string) => {
    if (!state || tabId === undefined || !yummy || player === yummy.player)
      return;
    const pageUrl = state.page.url;
    setLoadingPlayer(true);
    setNotice(undefined);
    try {
      const catalog = (await chrome.runtime.sendMessage({
        player,
        tabId,
        type: "yummy:catalog",
      })) as YummyCatalog & { error?: string };
      if (catalog.error) throw new Error(catalog.error);
      const current = (await chrome.runtime.sendMessage({
        tabId,
        type: "state:get",
      })) as TabState & { error?: string };
      if (current.error) throw new Error(current.error);
      if (current.page.url !== pageUrl)
        throw new Error("Страница аниме изменилась. Откройте popup заново.");
      setYummy(catalog.context);
      setYummySourceKeys(new Set(catalog.context.sources.map(yummySourceKey)));
      setYummySourcesTouched(false);
      setYummyEstimate(undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingPlayer(false);
    }
  };

  const enqueue = async () => {
    if (!state || tabId === undefined || (!yummy && !sourceId)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      if (yummy) {
        if (episodes.size === 0) throw new Error("Выберите хотя бы одну серию");
        const selectedSources = yummy.sources.filter((source) =>
          yummySourceKeys.has(yummySourceKey(source)),
        );
        if (selectedSources.length === 0)
          throw new Error("Выберите хотя бы одну озвучку или субтитры");
        const result = (await chrome.runtime.sendMessage({
          request: {
            container: "mkv",
            context: yummy,
            episodes: [...episodes].sort((a, b) => a - b),
            pageUrl: state.page.url,
            selectedSources,
            tabId,
          },
          type: "yummy:batch",
        })) as YummyBatchResult & { error?: string };
        if (result.error) throw new Error(result.error);
        setQueue(result.queue);
      } else {
        const job = buildCurrentJob(
          state,
          sourceId,
          [...audioIds],
          [...subtitleIds],
          container,
        );
        const nextQueue = (await chrome.runtime.sendMessage({
          jobs: [job],
          type: "queue:add",
        })) as QueueSnapshot;
        setQueue(nextQueue);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const found = primary.length > 0;
  const hasMedia = found || Boolean(yummy);
  const yummyAudio =
    yummy?.sources.filter((source) => source.kind === "audio") ?? [];
  const yummySubtitles =
    yummy?.sources.filter((source) => source.kind === "subtitle") ?? [];
  const estimatedSizes = new Map(
    yummyEstimate?.tracks.flatMap((track) =>
      track.bytes ? [[track.key, track.bytes] as const] : [],
    ) ?? [],
  );
  const selectedEstimateBytes = [...yummySourceKeys].reduce(
    (total, key) => total + (estimatedSizes.get(key) ?? 0),
    0,
  );
  const enqueueLabel = busy
    ? t(yummy ? "Собираем дорожки…" : "Добавляем…")
    : yummy
      ? t("Скачать {episodes}", {
          episodes: itemCount(language, episodes.size, "episodes"),
        })
      : t("Скачать видео");

  return (
    <main class="shell">
      <Header />

      {!ready && (
        <section class="empty-state loading">
          <h1>{t("Смотрим страницу")}</h1>
          <i />
        </section>
      )}

      {ready && !hasMedia && (
        <section class="empty-state">
          <h1>{t(state ? "Запустите видео" : "Страница недоступна")}</h1>
          <p>
            {t(
              state
                ? "После начала воспроизведения здесь появятся качество, звук и субтитры."
                : "Не удалось прочитать активную вкладку.",
            )}
          </p>
        </section>
      )}

      {ready && hasMedia && (
        <section class="download-panel">
          <div class="page-heading">
            <h1>{state?.page.title || t("Текущая страница")}</h1>
          </div>

          {found && !yummy && (
            <label class="field source-field">
              <span>{t("Источник")}</span>
              <select
                value={sourceId}
                onChange={(event) => setSourceId(event.currentTarget.value)}
              >
                {primary.map((resource) => (
                  <option value={resource.id} key={resource.id}>
                    {resource.name || providerName(resource, t("Источник"))} [{quality(resource)}]
                    {resource.episode !== undefined ? ` ${t("Серия {number}", { number: resource.episode })}` : ""}
                    {frames.length > 1 ? ` ${t("Плеер {number}", { number: frames.indexOf(resource.frameId) + 1 })}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {yummy && (
            <section class="yummy-options">
              <div class="yummy-controls">
                <label class="field">
                  <span>{t("Плеер")}</span>
                  <select
                    disabled={loadingPlayer}
                    value={yummy.player}
                    onChange={(event) =>
                      void selectYummyPlayer(event.currentTarget.value)
                    }
                  >
                    {yummy.playerOptions.map((option) => (
                      <option value={option} key={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <YummySourcePicker
                  estimating={estimating}
                  title={t("Озвучки")}
                  sources={yummyAudio}
                  selected={yummySourceKeys}
                  sizeByKey={estimatedSizes}
                  onChange={(keys) => {
                    setYummySourcesTouched(true);
                    setYummySourceKeys(keys);
                  }}
                />
                <YummySourcePicker
                  estimating={estimating}
                  title={t("Субтитры")}
                  sources={yummySubtitles}
                  selected={yummySourceKeys}
                  sizeByKey={estimatedSizes}
                  onChange={(keys) => {
                    setYummySourcesTouched(true);
                    setYummySourceKeys(keys);
                  }}
                />
              </div>
              <EpisodePicker
                context={yummy}
                selected={episodes}
                onChange={(next) => {
                  setEpisodesTouched(true);
                  setEpisodes(next);
                }}
              />
            </section>
          )}

          {!yummy && (audio.length > 0 || subtitles.length > 0) && (
            <section class="track-section">
              <ToggleList
                title={t("Аудиодорожки")}
                resources={audio}
                selected={audioIds}
                onChange={(ids) => {
                  setAudioTouched(true);
                  setAudioIds(ids);
                }}
              />
              <ToggleList
                title={t("Субтитры")}
                resources={subtitles}
                selected={subtitleIds}
                onChange={(ids) => {
                  setSubtitlesTouched(true);
                  setSubtitleIds(ids);
                }}
              />
            </section>
          )}

          <div class="download-actions">
            {!yummy && (
              <div class="segmented">
                <button
                  class={container === "mkv" ? "selected" : ""}
                  type="button"
                  aria-pressed={container === "mkv"}
                  onClick={() => setContainer("mkv")}
                >
                  MKV
                </button>
                <button
                  class={container === "mp4" ? "selected" : ""}
                  type="button"
                  aria-pressed={container === "mp4"}
                  onClick={() => setContainer("mp4")}
                >
                  MP4
                </button>
              </div>
            )}
            {yummy && (
              <span class="estimate-total">
                {estimating
                  ? t("Считаем размер…")
                  : selectedEstimateBytes > 0
                    ? `≈ ${fileSize(selectedEstimateBytes, language)}`
                    : ""}
              </span>
            )}
            <button
              class="primary"
              type="button"
              disabled={
                busy ||
                (yummy
                  ? episodes.size === 0 || yummySourceKeys.size === 0
                  : !sourceId)
              }
              onClick={() => void enqueue()}
            >
              {enqueueLabel}
            </button>
          </div>
          {tabId !== undefined && state && (
            <ProductActions
              tabId={tabId}
              pageUrl={state.page.url}
              sourceId={sourceId}
              audioIds={[...audioIds]}
              subtitleIds={[...subtitleIds]}
              currentVideo={Boolean(yummy)}
            />
          )}
        </section>
      )}

      {notice && <ErrorNotice message={notice} />}

      <Queue
        queue={queue}
        onCancel={(jobId) => {
          void chrome.runtime
            .sendMessage({ jobId, type: "queue:cancel" })
            .then(setQueue);
        }}
      />
    </main>
  );
}

function App() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<{ id: number; url: string } | null>();

  useEffect(() => {
    let mounted = true;
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([active]) => {
        if (mounted)
          setTab(
            active?.id === undefined
              ? null
              : { id: active.id, url: active.url ?? "" },
          );
      })
      .catch(() => {
        if (mounted) setTab(null);
      });
    const updated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      const url = change.url;
      if (url)
        setTab((current) => (current?.id === id ? { id, url } : current));
    };
    chrome.tabs.onUpdated.addListener(updated);
    return () => {
      mounted = false;
      chrome.tabs.onUpdated.removeListener(updated);
    };
  }, []);

  if (tab === undefined)
    return (
      <main class="shell">
        <Header />
        <section class="empty-state loading">
          <h1>{t("Открываем страницу")}</h1>
          <i />
        </section>
      </main>
    );
  const url = youtubeVideoUrl(tab?.url);
  const platform = platformReference(tab?.url);
  if (platform && tab)
    return (
      <PlatformPanel
        key={`${tab.id}:${platform.url}`}
        tabId={tab.id}
        reference={platform}
      />
    );
  return url && tab ? (
    <YoutubePanel
      key={`${tab.id}:${url}`}
      tabId={tab.id}
      url={url}
      music={new URL(tab.url).hostname === "music.youtube.com"}
    />
  ) : (
    <UniversalApp />
  );
}

render(
  <LanguageProvider>
    <App />
  </LanguageProvider>,
  document.getElementById("app")!,
);
