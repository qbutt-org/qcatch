import type {
  PageContext,
  YummyCatalog,
  YummyContext,
  YummyProbeSource,
  YummySource,
} from "../shared/types.ts";
import { sameYummySource } from "../shared/yummy.ts";

const YUMMY_HOSTS = new Set(["old.yummyani.me", "ru.yummyani.me"]);
const ALLOHA_CATALOG_CHANNEL = "qcatch:alloha-catalog";

type AllohaTranslation = {
  episodes: number[];
  id: string;
  name: string;
};

type AllohaFileList = {
  all?: Record<string, {
    file?: Record<string, Record<string, unknown>>;
    name?: string;
  }>;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function comboboxes(root: Document = document): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[role="combobox"], input[id^="react-select-"]')]
    .filter((input, index, values) => values.indexOf(input) === index);
}

export function normalizeYummyOptionLabel(value: string): string {
  const normalized = value
    .replace(/\u00a0/g, " ")
    .replace(/^(?:озвучка|плеер|субтитры|voice(?: acting)?|player|subtitles?)\s*/i, "")
    .replace(/\s*\d+\s*\/\s*\d+(?:[.,]\d+)?\s*[KMBКМ]?\s*$/i, "")
    .replace(/\s*\d+\s*(?:\/|из|of)\s*\d+\s*$/i, "")
    .replace(/\s*\(\s*\d+\s*(?:эп(?:изод(?:а|ов)?)?\.?|сер(?:ия|ии|ий)?|episodes?)\s*\)\s*$/i, "")
    .trim();
  return normalized || (/^(?:субтитры|subtitles?)/i.test(value.trim()) ? "Субтитры" : "");
}

function ownText(element: HTMLElement): string {
  if (!element.childNodes) return element.textContent?.trim() ?? "";
  return [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function readYummyOptionLabel(
  element: HTMLElement,
  expectedPrefix: RegExp = /^(?:озвучка|плеер|voice(?: acting)?|player)(?:\s|$)/i,
): string {
  const descendants = typeof element.querySelectorAll === "function"
    ? [...element.querySelectorAll<HTMLElement>("*")]
    : [];
  const semantic = [element, ...descendants]
    .map(ownText)
    .find((value) => expectedPrefix.test(value));
  const fallback = element.textContent?.trim() ?? "";
  if (!semantic && !expectedPrefix.test(fallback)) return "";
  return normalizeYummyOptionLabel(semantic ?? fallback);
}

export function parseYummySourceLabel(value: string): YummySource | undefined {
  const text = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const subtitle = /^(?:субтитры|subtitles?)(?=\s|\d|$)/i.test(text);
  if (!subtitle && !/^(?:озвучка|voice(?: acting)?)(?=\s|\d|$)/i.test(text)) return undefined;
  return {
    kind: subtitle ? "subtitle" : "audio",
    name: normalizeYummyOptionLabel(text) || (subtitle ? "Субтитры" : "Озвучка"),
  };
}

function readYummySourceOption(element: HTMLElement): YummySource | undefined {
  const descendants = typeof element.querySelectorAll === "function"
    ? [...element.querySelectorAll<HTMLElement>("*")]
    : [];
  const semantic = [element, ...descendants]
    .map(ownText)
    .find((value) => /^(?:озвучка|субтитры|voice(?: acting)?|subtitles?)(?=\s|\d|$)/i.test(value));
  return parseYummySourceLabel(semantic ?? element.textContent?.trim() ?? "");
}

export function readComboboxSelection(input: HTMLInputElement): string {
  const inputValue = input.value.trim();
  if (inputValue) return normalizeYummyOptionLabel(inputValue);

  const valueContainer = input.parentElement?.parentElement;
  const selectedValue = valueContainer
    ?.querySelector<HTMLElement>('[class*="-singleValue"], [class*="__single-value"]')
    ?? undefined;
  return selectedValue ? readYummyOptionLabel(selectedValue) : "";
}

function selectedComboboxValues(root: Document): string[] {
  return comboboxes(root)
    .map(readComboboxSelection)
    .filter(Boolean);
}

function playerInput(inputs: HTMLInputElement[]): HTMLInputElement | undefined {
  return inputs.find((input) => /alloha|kodik|cvh|cdnvideo/i.test(readComboboxSelection(input))) ?? inputs[1];
}

function sourceInput(inputs: HTMLInputElement[]): HTMLInputElement | undefined {
  return inputs.find((input) => readYummySourceOption(input.parentElement?.parentElement ?? input) !== undefined);
}

async function optionsFor(input: HTMLInputElement | undefined, expectedPrefix: RegExp): Promise<string[]> {
  if (!input) return [];
  const options = await openOptions(input);
  const labels = options
    .map((option) => readYummyOptionLabel(option, expectedPrefix))
    .filter(Boolean);
  await closeOptions(input);
  return [...new Set(labels)];
}

async function sourcesFor(input: HTMLInputElement | undefined): Promise<YummySource[]> {
  if (!input) return [];
  const options = await openOptions(input);
  const sources = options
    .map(readYummySourceOption)
    .filter((source): source is YummySource => source !== undefined);
  await closeOptions(input);
  return sources.filter((source, index) =>
    sources.findIndex((candidate) => candidate.kind === source.kind && candidate.name === source.name) === index,
  );
}

function listboxOptions(input: HTMLInputElement): HTMLElement[] {
  const controls = input.getAttribute("aria-controls");
  const root = controls ? input.ownerDocument.getElementById(controls) : null;
  return root ? [...root.querySelectorAll<HTMLElement>('[role="option"]')] : [];
}

async function openOptions(input: HTMLInputElement): Promise<HTMLElement[]> {
  const KeyboardEventConstructor = input.ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
  input.focus();
  input.dispatchEvent(new KeyboardEventConstructor("keydown", {
    bubbles: true,
    cancelable: true,
    code: "ArrowDown",
    key: "ArrowDown",
  }));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(50);
    const options = listboxOptions(input);
    if (options.length > 0) return options;
  }
  return [];
}

async function closeOptions(input: HTMLInputElement): Promise<void> {
  const KeyboardEventConstructor = input.ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
  input.dispatchEvent(new KeyboardEventConstructor("keydown", { bubbles: true, key: "Escape" }));
  input.blur();
  await wait(40);
}

async function selectOption(
  input: HTMLInputElement | undefined,
  label: string,
  expectedPrefix: RegExp = /^(?:озвучка|плеер|voice(?: acting)?|player)(?:\s|$)/i,
): Promise<void> {
  const normalizedLabel = normalizeYummyOptionLabel(label);
  if (!input || !normalizedLabel || readComboboxSelection(input) === normalizedLabel) return;
  const option = (await openOptions(input))
    .find((candidate) => readYummyOptionLabel(candidate, expectedPrefix) === normalizedLabel);
  if (!option) {
    await closeOptions(input);
    throw new Error(`Вариант «${normalizedLabel}» не найден на странице`);
  }
  option.click();
  await wait(650);
}

async function selectSourceOption(input: HTMLInputElement | undefined, source: YummySource): Promise<void> {
  const selected = input ? readYummySourceOption(input.parentElement?.parentElement ?? input) : undefined;
  if (!input || selected?.kind === source.kind && selected.name === source.name) return;
  const option = (await openOptions(input)).find((candidate) => {
    const parsed = readYummySourceOption(candidate);
    return parsed?.kind === source.kind && parsed.name === source.name;
  });
  if (!option) {
    await closeOptions(input);
    throw new Error(`Источник «${source.name}» не найден на странице`);
  }
  option.click();
  await wait(650);
}

export async function discoverYummyOptions(root: Document = document): Promise<YummyContext | undefined> {
  const context = scanYummyContext(root);
  if (!context) return undefined;
  const inputs = comboboxes(root);
  const alloha = /alloha/i.test(context.player);
  const listedSources = alloha ? [] : await sourcesFor(sourceInput(inputs));
  const playerOptions = await optionsFor(playerInput(inputs), /^(?:плеер|player)/i);
  const allohaSources = alloha
    ? await probeSourcesFromAlloha(context, listedSources).catch(() => [])
    : [];
  return {
    ...context,
    sources: allohaSources.length > 0
      ? allohaSources.map(({ kind, name }) => ({ kind, name }))
      : listedSources.length > 0 ? listedSources : context.sources,
    playerOptions: playerOptions.length > 0 ? playerOptions : context.playerOptions,
  };
}

async function waitForYummyContext(root: Document, player?: string): Promise<YummyContext> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const context = scanYummyContext(root);
    if (context && (!player || normalizeYummyOptionLabel(context.player) === normalizeYummyOptionLabel(player))) {
      return context;
    }
    await wait(250);
  }
  throw new Error(player ? `Плеер ${player} не загрузился` : "YummyAnime не загрузил плеер");
}

function decodeSingleQuotedString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[index + 1];
    index += 1;
    if (escape === undefined) throw new Error("Незавершённая escape-последовательность Alloha");
    const simple: Record<string, string> = {
      "'": "'",
      "\\": "\\",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      '"': '"',
    };
    if (escape in simple) {
      result += simple[escape];
      continue;
    }
    if (escape === "x" || escape === "u") {
      const digits = escape === "x" ? 2 : 4;
      const hexadecimal = value.slice(index + 1, index + 1 + digits);
      if (!new RegExp(`^[0-9a-f]{${digits}}$`, "i").test(hexadecimal)) {
        throw new Error("Некорректная escape-последовательность Alloha");
      }
      result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
      index += digits;
      continue;
    }
    if (escape !== "\n" && escape !== "\r") result += escape;
  }
  return result;
}

export function parseAllohaFileList(script: string): AllohaTranslation[] {
  const marker = "const fileList = JSON.parse('";
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) return [];
  const start = markerIndex + marker.length;
  let end = start;
  for (; end < script.length; end += 1) {
    if (script[end] !== "'") continue;
    let backslashes = 0;
    for (let index = end - 1; index >= start && script[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 0) break;
  }
  if (end >= script.length) return [];

  let fileList: AllohaFileList;
  try {
    fileList = JSON.parse(decodeSingleQuotedString(script.slice(start, end))) as AllohaFileList;
  } catch {
    return [];
  }
  return Object.entries(fileList.all ?? {}).flatMap(([key, translation]) => {
    const id = key.match(/^t(\d+)$/)?.[1];
    const name = translation.name?.trim();
    if (!id || !name) return [];
    const episodes = [...new Set(Object.values(translation.file ?? {}).flatMap((season) =>
      Object.keys(season).map(Number).filter((episode) => Number.isInteger(episode) && episode > 0),
    ))].sort((left, right) => left - right);
    return [{ episodes, id, name }];
  });
}

function selectedSources<T extends YummySource>(sources: T[], requested?: YummySource[]): T[] {
  if (!requested) return sources;
  return sources.filter((source) => requested.some((candidate) => sameYummySource(source, candidate)));
}

function allohaTranslations(root: Document = document): AllohaTranslation[] {
  const script = [...root.scripts]
    .map((element) => element.textContent ?? "")
    .find((text) => text.includes("const fileList = JSON.parse('"));
  return script ? parseAllohaFileList(script) : [];
}

export function listenForAllohaCatalogRequests(): void {
  if (!/alloha/i.test(location.hostname)) return;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (!event.data || typeof event.data !== "object") return;
    const request = event.data as { channel?: unknown; requestId?: unknown; type?: unknown };
    if (request.channel !== ALLOHA_CATALOG_CHANNEL || request.type !== "request" || typeof request.requestId !== "string") return;
    window.parent.postMessage({
      channel: ALLOHA_CATALOG_CHANNEL,
      requestId: request.requestId,
      translations: allohaTranslations(),
      type: "response",
    }, "*");
  });
}

export function preferMaximumAllohaProbeQuality(): void {
  if (!/alloha/i.test(location.hostname) || !new URL(location.href).searchParams.has("sc_probe")) return;
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(localStorage.getItem("allplay") ?? "{}") as Record<string, unknown>;
  } catch {
    // Replace malformed player settings with the one value required by a probe.
  }
  settings.quality = 2160;
  try {
    localStorage.setItem("allplay", JSON.stringify(settings));
  } catch {
    // Storage can be disabled in hardened third-party-frame policies.
  }
}

async function requestAllohaTranslations(iframe: HTMLIFrameElement): Promise<AllohaTranslation[]> {
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) return [];
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => finish([]), 2_500);
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== frameWindow || !event.data || typeof event.data !== "object") return;
      const response = event.data as { channel?: unknown; requestId?: unknown; translations?: unknown; type?: unknown };
      if (response.channel !== ALLOHA_CATALOG_CHANNEL || response.type !== "response" || response.requestId !== requestId) return;
      const translations = Array.isArray(response.translations) ? response.translations : [];
      finish(translations.filter((translation): translation is AllohaTranslation => {
        if (!translation || typeof translation !== "object") return false;
        const candidate = translation as Partial<AllohaTranslation>;
        return typeof candidate.id === "string"
          && typeof candidate.name === "string"
          && Array.isArray(candidate.episodes)
          && candidate.episodes.every((episode) => Number.isInteger(episode) && episode > 0);
      }));
    };
    const finish = (translations: AllohaTranslation[]) => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve(translations);
    };
    window.addEventListener("message", listener);
    frameWindow.postMessage({ channel: ALLOHA_CATALOG_CHANNEL, requestId, type: "request" }, "*");
  });
}

function matchingSource(name: string, knownSources: YummySource[]): YummySource {
  const normalized = normalizeYummyOptionLabel(name).toLocaleLowerCase();
  return knownSources.find((source) => normalizeYummyOptionLabel(source.name).toLocaleLowerCase() === normalized)
    ?? { kind: /sub(?:title)?|субтитр/i.test(name) ? "subtitle" : "audio", name };
}

async function probeSourcesFromAlloha(context: YummyContext, knownSources: YummySource[]): Promise<YummyProbeSource[]> {
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[src]")];
  const iframe = frames.find((candidate) => candidate.src === context.iframeUrl)
    ?? frames.find((candidate) => /alloha/i.test(candidate.src));
  if (!iframe) return [];
  const translations = await requestAllohaTranslations(iframe);
  return translations.map((translation) => {
    const source = matchingSource(translation.name, knownSources);
    const iframeUrl = new URL(context.iframeUrl);
    iframeUrl.searchParams.set("translation", translation.id);
    return {
      ...source,
      episodes: translation.episodes,
      iframeUrl: iframeUrl.href,
      probeId: translation.id,
    };
  });
}

async function collectSourcesBySelection(
  player: string,
  original: YummyContext,
  listedSources: YummySource[],
): Promise<YummyProbeSource[]> {
  const sources: YummyProbeSource[] = [];
  try {
    const ordered = [...listedSources].sort((left, right) =>
      Number(sameYummySource(right, original.source)) - Number(sameYummySource(left, original.source)),
    );
    for (const source of ordered) {
      try {
        let inputs = comboboxes();
        await selectSourceOption(sourceInput(inputs), source);
        inputs = comboboxes();
        await selectOption(playerInput(inputs), player, /^(?:плеер|player)(?:\s|$)/i);
        const selected = await waitForYummyContext(document, player);
        if (normalizeYummyOptionLabel(selected.player) !== normalizeYummyOptionLabel(player)) continue;
        sources.push({ ...source, iframeUrl: selected.iframeUrl, probeId: String(sources.length) });
      } catch {
        // A source can legitimately be unavailable in the selected player.
      }
    }
  } finally {
    let inputs = comboboxes();
    await selectSourceOption(sourceInput(inputs), original.source).catch(() => undefined);
    inputs = comboboxes();
    await selectOption(playerInput(inputs), original.player, /^(?:плеер|player)(?:\s|$)/i).catch(() => undefined);
  }
  return sources;
}

export async function collectYummyCatalog(player: string, requestedSources?: YummySource[]): Promise<YummyCatalog> {
  const original = scanYummyContext();
  if (!original) throw new Error("Плеер YummyAnime больше не найден");
  const alloha = /alloha/i.test(player);
  const inputs = comboboxes();
  const listedSources = alloha
    ? requestedSources ?? []
    : selectedSources(await sourcesFor(sourceInput(inputs)), requestedSources);
  const playerOptions = await optionsFor(playerInput(inputs), /^(?:плеер|player)/i);

  await selectOption(playerInput(comboboxes()), player, /^(?:плеер|player)(?:\s|$)/i);
  const selected = await waitForYummyContext(document, player);
  let sources = alloha ? await probeSourcesFromAlloha(selected, listedSources) : [];
  if (sources.length === 0) sources = await collectSourcesBySelection(player, original, listedSources);
  sources = selectedSources(sources, requestedSources);
  if (sources.length === 0) throw new Error(`Плеер ${player} не отдал ни одной выбранной дорожки`);

  if (original.player !== player) {
    await selectOption(playerInput(comboboxes()), original.player, /^(?:плеер|player)(?:\s|$)/i).catch(() => undefined);
  }
  return {
    context: {
      ...selected,
      player,
      playerOptions: playerOptions.length > 0 ? playerOptions : original.playerOptions,
      sources: sources.map(({ kind, name }) => ({ kind, name })),
    },
    sources,
  };
}

export async function probeYummyEpisode(sources: YummyProbeSource[], episode: number): Promise<void> {
  const iframes = sources.filter((source) => !source.episodes || source.episodes.includes(episode)).map((source) => {
    const url = new URL(source.iframeUrl);
    url.searchParams.set("episode", String(episode));
    url.searchParams.set("sc_probe", String(episode));
    url.searchParams.set("sc_source", source.probeId);
    const iframe = document.createElement("iframe");
    iframe.src = url.href;
    iframe.allow = "autoplay; fullscreen";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;left:-16px;top:-16px;width:8px;height:8px;opacity:.01;pointer-events:none;border:0";
    document.body.append(iframe);
    return iframe;
  });
  try {
    await Promise.race([
      Promise.all(iframes.map((iframe) => new Promise<void>((resolve) => {
        iframe.addEventListener("load", () => resolve(), { once: true });
      }))),
      wait(4_000),
    ]);
    await wait(5_500);
  } finally {
    for (const iframe of iframes) iframe.remove();
  }
}

function selectedButtonText(root: Document, pattern: RegExp): string | undefined {
  return [...root.querySelectorAll<HTMLElement>("button,[role=button]")]
    .map((button) => button.textContent?.trim() ?? "")
    .find((text) => pattern.test(text));
}

function episodeElements(root: Document): HTMLElement[] {
  const hasEpisodeNumber = (element: HTMLElement): boolean => {
    const episode = Number(element.textContent?.trim());
    return Number.isInteger(episode) && episode >= 1 && episode <= 500;
  };
  const interactive = [...root.querySelectorAll<HTMLElement>("button,[role=button],[data-episode]")]
    .filter(hasEpisodeNumber);
  const numericLeaves = [...root.querySelectorAll<HTMLElement>("a,div,li,span")]
    .filter((element) => element.childElementCount === 0 && hasEpisodeNumber(element));
  const candidates = [...new Set([...interactive, ...numericLeaves])];
  const siblingGroups = new Map<Element, Set<HTMLElement>>();
  for (const candidate of candidates) {
    let ancestor = candidate.parentElement;
    for (let depth = 0; ancestor && depth < 2; depth += 1, ancestor = ancestor.parentElement) {
      const group = siblingGroups.get(ancestor) ?? new Set<HTMLElement>();
      group.add(candidate);
      siblingGroups.set(ancestor, group);
    }
  }
  const sequence = [...siblingGroups.values()]
    .map((group) => {
      const elements = [...group];
      return {
        elements,
        size: new Set(elements.map((element) => element.textContent?.trim())).size,
      };
    })
    .filter((group) => group.size > 1)
    .sort((left, right) => right.size - left.size)[0];
  return sequence?.elements ?? interactive;
}

function episodeNumbers(elements: HTMLElement[]): number[] {
  return [...new Set(elements.map((element) => Number(element.textContent?.trim())))]
    .sort((left, right) => left - right);
}

function currentEpisode(iframeUrl: string, available: number[], elements: HTMLElement[]): number {
  const active = elements.find((element) => {
    const text = element.textContent?.trim() ?? "";
    if (!/^\d{1,3}$/.test(text)) return false;
    return element.getAttribute("aria-selected") === "true"
      || element.getAttribute("data-state") === "active"
      || /(?:^|\s)(?:active|current|selected)(?:\s|$)/i.test(element.className);
  });
  if (active?.textContent) return Number(active.textContent.trim());

  try {
    const fromUrl = Number(new URL(iframeUrl).searchParams.get("episode"));
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
  } catch {
    // The iframe may briefly have an empty src while React changes the player.
  }

  return available[0] ?? 1;
}

export function scanYummyContext(root: Document = document): YummyContext | undefined {
  if (!YUMMY_HOSTS.has(root.location.hostname)) return undefined;
  const iframe = root.querySelector<HTMLIFrameElement>('iframe[title="Видео"], iframe[title="Video"], iframe[src*="iframeCVH"], iframe[src*="kodik"], iframe[src*="alloha"]');
  if (!iframe?.src) return undefined;

  const inputs = comboboxes(root);
  const values = selectedComboboxValues(root);
  const player = values.find((value) => /alloha|kodik|cvh|cdnvideo/i.test(value))
    ?? selectedButtonText(root, /alloha|kodik|cvh|cdnvideo/i)
    ?? "Текущий плеер";
  const source = readYummySourceOption(sourceInput(inputs)?.parentElement?.parentElement ?? root.body)
    ?? { kind: "audio", name: "Текущая озвучка" };
  const elements = episodeElements(root);
  const detectedEpisodes = episodeNumbers(elements);
  const episode = currentEpisode(iframe.src, detectedEpisodes, elements);
  const available = detectedEpisodes.length > 0 ? detectedEpisodes : [episode];
  const title = root.querySelector("h1")?.textContent?.trim() || root.title.split(/[—|]/)[0]?.trim() || root.title;

  return {
    episode,
    episodes: { available },
    iframeUrl: iframe.src,
    player,
    playerOptions: [player],
    source,
    sources: [source],
    title,
  };
}

export function scanPageContext(): PageContext {
  const yummy = scanYummyContext();
  return {
    title: yummy?.title || document.querySelector("h1")?.textContent?.trim() || document.title || "Текущая страница",
    url: location.href,
    ...(yummy ? { yummy } : {}),
  };
}
