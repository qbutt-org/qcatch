import { addQueueJobs, readQueue, replaceQueueJob, updateQueueItem } from "../src/background/queue.ts";
import type { DownloadJob, QueueStatus } from "../src/shared/types.ts";
import { runDownload } from "../src/offscreen/download.ts";
import { handleIntegration, resolveCapture } from "../src/background/integration.ts";
import { removeProductActions } from "../src/background/product-actions.ts";
import { addCapture, readTabState, updatePage } from "../src/background/state.ts";
import type { IntegrationMessage, ProductAction, ProductSelection } from "../src/shared/integration.ts";
import { NATIVE_BRIDGE_URL } from "../src/shared/native.ts";
import { audioResourcesForSource, buildCurrentJob, defaultAudioSelection } from "../src/shared/jobs.ts";

// Runs production background/session handlers against isolated browser metadata and
// a real loopback HTTP fixture, plus the production downloader with generated HLS and injected OPFS faults.
// It never connects to the installed helper or fetches external media.
const tabId = 71;
const pageUrl = "https://example.org/sintel";
const mediaUrl = "https://media.w3.org/2010/05/sintel/trailer.mp4";
const session = new Map<string, unknown>();
const frames = new Map<number, { url: string; documentId: string; media: string[] }>();
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let tabUrl = pageUrl;
let cookieFailure = false;
let missingReceiver = false;
let cookieReadHook: (() => void) | undefined;
let scriptReads = 0;
let installed = false;
let dropResponse = false;
let passed = 0;
const deadline = setTimeout(() => {
  console.error("Product-action integration exceeded 15 seconds");
  process.exit(1);
}, 15_000);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

let reply: { body: unknown; status?: number; entered?: ReturnType<typeof deferred>; release?: ReturnType<typeof deferred> } | undefined;
let storageGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
let tabReadHook: (() => void) | undefined;
let runtimeHook: ((message: { type: string; status?: string; error?: string }) => Promise<unknown>) | undefined;
let mediaGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/cleanup-fixture.m3u8") {
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\ncleanup-fixture.ts\n#EXT-X-ENDLIST", {
        headers: { "Content-Type": "application/x-mpegurl" },
      });
    }
    if (path === "/cleanup-fixture.ts" || path === "/cleanup-fixture.mp4") {
      mediaGate!.entered.resolve();
      await mediaGate!.release.promise;
      return new Response(new Uint8Array());
    }
    check(request.headers.get("X-Qcatch") === "1", "Native request lost its extension marker");
    if (path === "/health") {
      return Response.json({ protocol: 1, version: "fixture", desktopPath: "fixture", qplayInstalled: installed,
        qbuttInstalled: installed, tools: { status: "ready" } });
    }
    check(request.method === "POST", "Unexpected native request method");
    posts.push({ path, body: await request.json() as Record<string, unknown> });
    const response = reply ?? { body: { opened: true } };
    reply = undefined;
    response.entered?.resolve();
    await response.release?.promise;
    return Response.json(response.body, { status: response.status ?? 200 });
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  check(url.origin === NATIVE_BRIDGE_URL, "Fixture attempted an external request");
  const lose = init?.method === "POST" && dropResponse;
  if (lose) dropResponse = false;
  const response = await realFetch(`${server.url.origin}${url.pathname}`, init);
  if (lose) throw new TypeError("Injected response loss after native dispatch");
  return response;
}) as typeof fetch;

Object.defineProperty(globalThis, "chrome", { value: {
  storage: { session: {
    async get(keys: string | string[] | null) {
      const selected = keys === null ? [...session.keys()] : typeof keys === "string" ? [keys] : keys;
      const values = Object.fromEntries(selected.filter((key) => session.has(key))
        .map((key) => [key, structuredClone(session.get(key))]));
      if (keys === `tab:${tabId}` && tabReadHook) {
        const hook = tabReadHook;
        tabReadHook = undefined;
        hook();
      }
      return values;
    },
    async set(values: Record<string, unknown>) {
      if (storageGate && Object.keys(values).some((key) => key.startsWith("product-actions:"))) {
        const gate = storageGate;
        storageGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      for (const [key, value] of Object.entries(values)) session.set(key, structuredClone(value));
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) session.delete(key);
    },
  } },
  tabs: {
    async get(id: number) {
      check(id === tabId, "Unexpected tab identity");
      return { id, url: tabUrl, title: "Sintel fixture" };
    },
    async sendMessage(id: number, message: { type: string }, options?: { frameId: number; documentId?: string }) {
      check(id === tabId, "Unexpected message tab");
      if (message.type !== "capture:identity") return {};
      if (missingReceiver) throw new Error("Could not establish connection. Receiving end does not exist.");
      const identity = frames.get(options!.frameId);
      check(identity, "Missing selected frame");
      check(!options?.documentId || identity.documentId === options.documentId, "capture_expired");
      return structuredClone(identity);
    },
  },
  scripting: { async executeScript(request: { target: { tabId: number; frameIds?: number[]; documentIds?: string[] }; args: string[] }) {
    scriptReads += 1;
    check(request.target.tabId === tabId && request.args[0] === new URL(tabUrl).origin,
      "YouTube snapshot lost its tab or origin guard");
    const identity = frames.get(0)!;
    check(request.target.documentIds ? request.target.documentIds[0] === identity.documentId
      : request.target.frameIds?.join() === "0", "capture_expired");
    return [{ documentId: identity.documentId, result: { url: tabUrl, time: 42.25, media: [...identity.media] } }];
  } },
  cookies: { async getAll() {
    if (cookieFailure) throw new Error("Injected preparation failure");
    const hook = cookieReadHook;
    cookieReadHook = undefined;
    hook?.();
    return [];
  } },
  action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
  runtime: { async sendMessage(message: { type: string; status?: string; error?: string }) {
    return runtimeHook?.(message);
  } },
} });

async function state(): Promise<ProductAction[]> {
  return await handleIntegration({ type: "integration:state", tabId }) as ProductAction[];
}

async function send(selection: ProductSelection, action: "play" | "watch" | "download", previousId?: string) {
  const command = { ...selection, ...(previousId ? { previousId } : {}) };
  const message: IntegrationMessage = action === "play"
    ? { ...command, type: "media:play" }
    : { ...command, type: "integration:handoff", action };
  return await handleIntegration(message) as ProductAction;
}

async function rejected(operation: Promise<unknown>, expected: string) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  check(failure instanceof Error && failure.message.includes(expected), `Expected ${expected}; received ${String(failure)}`);
}

async function scenario(name: string, operation: () => Promise<void>) {
  await removeProductActions(tabId);
  await operation();
  passed += 1;
  console.log(JSON.stringify({ scenario: name, status: "passed", nativePosts: posts.length }));
}

try {
  await updatePage(tabId, { url: pageUrl, title: "Sintel fixture" });
  for (const [frameId, kind, url] of [
    [4, "video", mediaUrl], [9, "video", mediaUrl],
    [5, "audio", "https://example.org/audio.m4a"], [6, "subtitle", "https://example.org/subtitle.vtt"],
  ] as const) {
    frames.set(frameId, { url: `https://example.org/player/${frameId}`, documentId: `document-${frameId}`, media: [url] });
    const headers = frameId === 4 ? [
      { name: "Range", value: "bytes=589824-" },
      { name: "If-Range", value: "\"sintel-etag\"" },
      { name: "Accept", value: "video/mp4" },
    ] : [];
    await addCapture(tabId, frameId,
      { kind, url, provider: "unknown", detectedAt: Date.now(), headers },
      `document-${frameId}`);
  }
  const resources = (await readTabState(tabId)).resources;
  const selected: ProductSelection = { tabId, pageUrl, sourceId: resources.find((resource) => resource.frameId === 4)!.id,
    audioIds: [resources.find((resource) => resource.kind === "audio")!.id],
    subtitleIds: [resources.find((resource) => resource.kind === "subtitle")!.id] };

  await scenario("health-refresh-and-frame-isolation", async () => {
    const missing = await handleIntegration({ type: "integration:health" }) as { qplayInstalled: boolean };
    installed = true;
    const ready = await handleIntegration({ type: "integration:health" }) as { qplayInstalled: boolean };
    check(!missing.qplayInstalled && ready.qplayInstalled, "Health was cached across install/retry");
    const duplicates = resources.filter((resource) => resource.url === mediaUrl);
    check(duplicates.length === 2 && duplicates[0]!.id !== duplicates[1]!.id, "Equal URLs collapsed different frames");
  });

  await scenario("playback-does-not-replay-browser-ranges", async () => {
    const before = posts.length;
    const action = await send(selected, "play");
    const post = posts.at(-1)!;
    check(action.status === "sent" && posts.length === before + 1 && post.path === "/play-media",
      "Selected playback did not reach the native helper");
    const headers = post.body.headers as Array<[string, string]>;
    check(!headers.some(([name]) => /^(?:range|if-range)$/i.test(name)),
      "Captured byte range overrode qplay's own requests");
    check(headers.some(([name, value]) => name === "Accept" && value === "video/mp4")
      && headers.some(([name, value]) => name === "Referer" && value === pageUrl)
      && headers.some(([name, value]) => name === "User-Agent" && value === navigator.userAgent),
    "Playback lost its request context while removing the captured range");
  });

  await scenario("popup-reopen-single-flight-and-exact-capture", async () => {
    const entered = deferred();
    const release = deferred();
    reply = { body: { opened: true }, entered, release };
    const before = posts.length;
    const first = send(selected, "watch");
    await entered.promise;
    const repeated = send(selected, "watch");
    check((await state()).at(-1)?.status === "sending", "Reopened popup lost its pending action");
    await rejected(send(selected, "download"), "Дождитесь текущей передачи");
    release.resolve();
    const [one, two] = await Promise.all([first, repeated]);
    check(one.id === two.id && one.status === "sent" && posts.length === before + 1, "Repeated message dispatched twice");
    const again = await send({ ...selected, pageUrl: `${pageUrl}#video` }, "watch");
    check(again.id === one.id && posts.length === before + 1, "Completed action dispatched twice");
    const uri = posts.at(-1)!.body.uri as string;
    const encoded = new URL(uri).searchParams.get("d")!;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as { captureId: string; pageUrl: string };
    const binding = session.get(`capture:${payload.captureId}`) as { frames: Array<{ frameId: number }>; resources: Array<{ id: string }> };
    check(binding.frames.map((frame) => frame.frameId).join() === "4,5,6", "Selected frame/document identities were lost");
    check(binding.resources.some((resource) => resource.id === selected.audioIds[0]), "Opaque track identity was lost");
    const resolved = await resolveCapture(payload.pageUrl, { captureId: payload.captureId });
    check(resolved.url === mediaUrl && "audioUrl" in resolved && resolved.audioUrl === "https://example.org/audio.m4a", "Capture resolved another source or track");
    frames.get(5)!.documentId = "replacement-audio-document";
    await rejected(resolveCapture(payload.pageUrl, { captureId: payload.captureId }), "capture_expired");
    frames.get(5)!.documentId = "document-5";
  });

  await scenario("clear-hls-relative-renditions-and-exact-audio", async () => {
    const masterUrl = "https://media.example.org/hls/master.m3u8";
    const masterBody = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="English",LANGUAGE="en",CHANNELS="2",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="French",LANGUAGE="fr",URI="audio/fr.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="German",LANGUAGE="de",CHANNELS="6",DEFAULT=YES,URI="audio/de.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=768x576,AUDIO="main"',
      "video/high.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,AUDIO="low"',
      "video/low.m3u8",
    ].join("\n");
    await addCapture(tabId, 20, {
      kind: "hls", url: "https://media.example.org/hls/audio/fr.m3u8",
      provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Authorization", value: "generated-child-session" }],
    }, "document-20");
    frames.set(20, { url: "https://example.org/player/20", documentId: "document-20", media: [masterUrl] });
    frames.set(21, { url: "https://example.org/player/21", documentId: "document-21", media: [masterUrl] });
    await addCapture(tabId, 21, {
      kind: "hls", url: masterUrl, provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Authorization", value: "generated-master-session" }],
    }, "document-21");
    for (const frameId of [20, 21]) {
      await addCapture(tabId, frameId, {
        kind: "hls", url: masterUrl, body: masterBody, provider: "unknown", detectedAt: Date.now(),
      }, "document-" + frameId);
    }
    await addCapture(tabId, 21, {
      kind: "audio", url: "https://media.example.org/unrelated.mp3",
      provider: "unknown", detectedAt: Date.now(),
    }, "document-21");
    let captured = await readTabState(tabId);
    const headerFirstMaster = captured.resources.find((item) => item.url === masterUrl && item.frameId === 21)!;
    const unplayedFrench = audioResourcesForSource(captured.resources, headerFirstMaster.id)
      .find((item) => item.language === "fr")!;
    const headerFirstJob = buildCurrentJob(captured, headerFirstMaster.id, [unplayedFrench.id], [], "mkv");
    check(headerFirstJob.inputs.every((item) => item.headers.some((header) => header.name === "Authorization"
      && header.value === "generated-master-session")),
    "A body-only master capture lost earlier request headers for an unplayed rendition");
    await addCapture(tabId, 21, {
      kind: "hls", url: masterUrl, provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Authorization", value: "generated-refreshed-master-session" }],
    }, "document-21");
    captured = await readTabState(tabId);
    const refreshedMasterJob = buildCurrentJob(captured, headerFirstMaster.id, [unplayedFrench.id], [], "mkv");
    check(refreshedMasterJob.inputs.every((item) => item.headers.some((header) => header.name === "Authorization"
      && header.value === "generated-refreshed-master-session")),
    "An unplayed rendition retained stale inherited master headers");
    await addCapture(tabId, 21, {
      kind: "hls", url: unplayedFrench.url, provider: "unknown", detectedAt: Date.now(),
      headers: [
        { name: "Authorization", value: "generated-observed-child-session" },
        { name: "Referer", value: "https://media.example.org/private-child?generated-child-referer" },
      ],
      referer: "https://media.example.org/private-child?generated-child-referer",
    }, "document-21");
    await addCapture(tabId, 21, {
      kind: "hls", url: masterUrl, body: masterBody, provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Authorization", value: "generated-newest-master-session" }],
    }, "document-21");
    captured = await readTabState(tabId);
    const observedChildJob = buildCurrentJob(captured, headerFirstMaster.id, [unplayedFrench.id], [], "mkv");
    check(observedChildJob.inputs[0]?.headers.some((header) => header.value === "generated-newest-master-session")
      && observedChildJob.inputs[1]?.headers.some((header) => header.value === "generated-observed-child-session"),
    "A master refresh replaced an observed child's own request headers");
    await addCapture(tabId, 21, {
      kind: "hls", url: unplayedFrench.url, provider: "unknown", detectedAt: Date.now(), headers: [],
    }, "document-21");
    captured = await readTabState(tabId);
    const clearedChildJob = buildCurrentJob(captured, headerFirstMaster.id, [unplayedFrench.id], [], "mkv");
    check(!clearedChildJob.inputs[1]?.headers.some((header) => header.name === "Authorization"
      || header.value.includes("generated-child-referer")),
      "An observed empty child request retained old private headers or inherited master credentials");
    const master = captured.resources.find((item) => item.url === masterUrl && item.frameId === 20)!;
    const audio = audioResourcesForSource(captured.resources, master.id);
    check(audio.length === 2 && audio.every((item) => item.frameId === 20 && item.hlsRendition?.groupId === "main"),
      "HLS audio crossed a frame or group boundary");
    check(defaultAudioSelection(audio).length === 1
      && audio.find((item) => item.id === defaultAudioSelection(audio)[0])?.language === "en",
    "HLS default ignored the authoritative rendition");
    const unrelatedAudio = captured.resources.find((item) => item.url.endsWith("/unrelated.mp3"))!;
    await rejected(Promise.resolve().then(() => buildCurrentJob(captured, master.id, [unrelatedAudio.id], [], "mkv")),
      "аудиодорожка больше не доступна");
    const french = audio.find((item) => item.language === "fr")!;
    check(french.headers?.some((header) => header.name === "Authorization" && header.value === "generated-child-session"),
      "Master discovery lost an earlier child playlist request header");
    const german = captured.resources.find((item) => item.frameId === 20 && item.language === "de")!;
    check(audio.find((item) => item.language === "en")?.hlsRendition?.channels === 2
      && german.hlsRendition?.channels === 6, "HLS rendition channel counts were lost");
    const hlsSelection = { tabId, pageUrl, sourceId: master.id, audioIds: [french.id], subtitleIds: [] };
    const job = buildCurrentJob(captured, master.id, [french.id], [], "mkv");
    check(job.inputs.length === 2 && job.inputs[0]?.url === "https://media.example.org/hls/video/high.m3u8"
      && job.inputs[1]?.url === "https://media.example.org/hls/audio/fr.m3u8"
      && job.inputs[1]?.kind === "hls" && job.inputs[1]?.role === "audio",
    "HLS job lost the exact maximum video or explicitly selected nondefault audio");
    await rejected(Promise.resolve().then(() => buildCurrentJob(captured, master.id, [german.id], [], "mkv")),
      "аудиодорожка больше не доступна");
    const audioOnly = buildCurrentJob(captured, french.id, [french.id], [], "mkv");
    check(audioOnly.inputs.length === 1 && audioOnly.inputs[0]?.role === "audio"
      && audioOnly.inputs[0]?.kind === "hls", "Selecting an HLS audio rendition added or lost a track");
    await addCapture(tabId, 20, {
      kind: "hls", url: "https://media.example.org/hls/video/low.m3u8",
      provider: "unknown", detectedAt: Date.now(),
    }, "document-20");
    captured = await readTabState(tabId);
    const low = captured.resources.find((item) => item.url.endsWith("/video/low.m3u8"))!;
    const lowAudio = audioResourcesForSource(captured.resources, low.id).filter((item) => item.hlsRendition);
    check(lowAudio.length === 1 && lowAudio[0]?.id === german.id,
      "An explicitly selected variant inherited another variant's audio group");
    await rejected(Promise.resolve().then(() => buildCurrentJob(captured, low.id, [french.id], [], "mkv")),
      "аудиодорожка больше не доступна");
    await addCapture(tabId, 20, {
      kind: "hls", url: "https://media.example.org/hls/other-master.m3u8",
      body: masterBody, provider: "unknown", detectedAt: Date.now(),
    }, "document-20");
    captured = await readTabState(tabId);
    check(audioResourcesForSource(captured.resources, master.id).filter((item) => item.hlsRendition).length === 2,
      "An exact master accepted another master's rendition");
    await rejected(Promise.resolve().then(() => buildCurrentJob(captured, low.id, [german.id], [], "mkv")),
      "основной HLS-плейлист");
    await addCapture(tabId, 20, {
      kind: "hls", url: french.url, provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Accept", value: "application/vnd.apple.mpegurl" }],
    }, "document-20");
    captured = await readTabState(tabId);
    const refreshed = captured.resources.filter((item) => item.url === french.url && item.frameId === 20);
    check(refreshed.length === 2 && new Set(refreshed.map((item) => item.id)).size === 2
      && refreshed.some((item) => item.id === french.id) && refreshed.every((item) => item.hlsRendition),
      "A child playlist request duplicated or detached its rendition");
    const action = await send(hlsSelection, "watch");
    check(action.status === "sent", "HLS capture did not reach the existing native handoff");
    const payload = JSON.parse(Buffer.from(new URL(posts.at(-1)!.body.uri as string).searchParams.get("d")!,
      "base64url").toString()) as { captureId: string; pageUrl: string };
    const resolved = await resolveCapture(payload.pageUrl, { captureId: payload.captureId });
    check(resolved.url === job.inputs[0]!.url && "audioUrl" in resolved && resolved.audioUrl === french.url,
      "HLS capture resolved another video or language");
    await addCapture(tabId, 20, {
      kind: "hls", url: masterUrl, body: masterBody.split("\n").filter((line) => !line.includes('NAME="French"')).join("\n"),
      provider: "unknown", detectedAt: Date.now(),
    }, "document-20");
    check(!(await readTabState(tabId)).resources.some((item) => item.id === french.id),
      "Master refresh retained a removed audio rendition");
    await rejected(resolveCapture(payload.pageUrl, { captureId: payload.captureId }), "capture_expired");
    await addCapture(tabId, 20, {
      kind: "hls", url: "https://media.example.org/hls/private-master.m3u8",
      referer: "https://media.example.org/private-share?generated-private-session",
      body: masterBody.replace("video/high.m3u8", "https://video.example.org/high.m3u8")
        .replace("audio/fr.m3u8", "https://audio.example.org/fr.m3u8"),
      headers: [
        { name: "Authorization", value: "generated-session" },
        { name: "X-Source-Session", value: "generated-session" },
        { name: "Referer", value: "https://media.example.org/private-share?generated-private-session" },
        { name: "Accept", value: "application/vnd.apple.mpegurl" },
      ],
      provider: "unknown", detectedAt: Date.now(),
    }, "document-20");
    captured = await readTabState(tabId);
    const privateMaster = captured.resources.find((item) => item.url.endsWith("/private-master.m3u8"))!;
    const privateFrench = audioResourcesForSource(captured.resources, privateMaster.id)
      .find((item) => item.hlsRendition && item.language === "fr")!;
    const crossOrigin = buildCurrentJob(captured, privateMaster.id, [privateFrench.id], [], "mkv");
    check(crossOrigin.inputs.every((item) => !item.headers.some((header) => /^(?:authorization|x-)/i.test(header.name))),
      "A cross-origin HLS child inherited the master's private headers");
    check(crossOrigin.inputs.every((item) => !item.headers.some((header) => header.value.includes("generated-private-session"))),
      "A cross-origin HLS child inherited the master request referer");
    check(crossOrigin.inputs.every((item) => item.headers.some((header) => header.name === "Accept")),
      "Cross-origin HLS children lost safe request headers");
  });

  await scenario("static-dash-capture-and-exact-external-subtitle", async () => {
    const manifestUrl = "https://media.example.org/dash/manifest.mpd";
    const body = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video">
      <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number$.m4s" duration="2" />
      <Representation id="maximum" width="640" height="360" bandwidth="1000000" />
      <Representation id="lower" width="320" height="180" bandwidth="5000000" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="eng">
      <SegmentTemplate initialization="init-audio.m4s" media="audio-$Number$.m4s" duration="2" />
      <Representation id="audio" bandwidth="128000" />
    </AdaptationSet>
  </Period>
</MPD>`;
    await addCapture(tabId, 30, {
      kind: "dash", url: manifestUrl, provider: "unknown", detectedAt: Date.now(),
      headers: [{ name: "Authorization", value: "generated-dash-session" }],
    }, "document-30");
    await addCapture(tabId, 30, {
      kind: "dash", url: manifestUrl, body, provider: "unknown", detectedAt: Date.now(),
    }, "document-30");
    for (const language of ["en", "ru"]) {
      await addCapture(tabId, 30, {
        kind: "subtitle", url: `https://media.example.org/dash/${language}.vtt`,
        language, name: language === "ru" ? "Русский" : "English", default: language === "en",
        provider: "unknown", detectedAt: Date.now(),
      }, "document-30");
    }
    const captured = await readTabState(tabId);
    const source = captured.resources.find((item) => item.url === manifestUrl)!;
    const subtitle = captured.resources.find((item) => item.url === "https://media.example.org/dash/ru.vtt")!;
    const job = buildCurrentJob(captured, source.id, [], [subtitle.id], "mkv");
    check(source.body === body && job.inputs.length === 1 && job.inputs[0]?.kind === "dash"
      && job.inputs[0]?.url === manifestUrl && job.inputs[0]?.headers.some((header) => header.value === "generated-dash-session"),
    "A DASH body-only capture lost the selected MPD or its observed request headers");
    check(job.subtitles.length === 1 && job.subtitles[0]?.url === subtitle.url
      && job.subtitles[0]?.language === "ru" && job.subtitles[0]?.name === "Русский",
    "DASH download included an unselected subtitle or lost selected language metadata");
  });

  await scenario("definite-native-rejection-explicit-retry", async () => {
    reply = { body: { error: "Injected native rejection" }, status: 503 };
    const before = posts.length;
    const failed = await send(selected, "play");
    check(failed.status === "failed", "Definite rejection became uncertain");
    check((await send(selected, "play")).id === failed.id && posts.length === before + 1, "Repeated rejection retried silently");
    const retry = await send(selected, "play", failed.id);
    check(retry.status === "sent" && posts.length === before + 2, "Explicit retry did not dispatch");
    check((await send(selected, "play", failed.id)).id === retry.id && posts.length === before + 2, "Repeated retry message redelivered");
    check((await state()).at(-1)?.error === undefined, "Successful retry retained the failed error");
  });

  await scenario("deliberate-open-again-and-old-message-replay", async () => {
    const before = posts.length;
    const first = await send(selected, "play");
    const entered = deferred();
    const release = deferred();
    reply = { body: { opened: true }, entered, release };
    const reopening = send(selected, "play", first.id);
    await entered.promise;
    check((await send(selected, "play")).id === first.id, "Old message was aliased to a later in-flight intent");
    const repeated = send(selected, "play", first.id);
    release.resolve();
    const second = await reopening;
    check((await repeated).id === second.id, "Repeated explicit reopening lost its in-flight owner");
    check(second.id !== first.id && second.status === "sent", "Definite sent permanently blocked intentional reopening");
    check((await send(selected, "play", first.id)).id === second.id && posts.length === before + 2, "Replayed reopen command spawned twice");
    const third = await send(selected, "play", second.id);
    check(third.id !== second.id && posts.length === before + 3, "Next explicit reopening did not create its own intent");
    check((await send(selected, "play", first.id)).id === second.id && posts.length === before + 3, "An older replay lost its ownership after a later opening");
  });

  await scenario("lost-response-and-preparation-fault-never-redeliver", async () => {
    dropResponse = true;
    const before = posts.length;
    const uncertain = await send(selected, "play");
    check(uncertain.status === "uncertain", "Lost response was declared a definite failure");
    cookieFailure = true;
    check((await send(selected, "play")).id === uncertain.id, "Repeated intent was recaptured after dispatch");
    cookieFailure = false;
    const recovered = await send(selected, "play");
    check(recovered.id === uncertain.id && posts.length === before + 1, "Preparation failure erased the uncertain receipt");
    await rejected(send(selected, "play", uncertain.id), "Выбор передачи устарел");
    check(posts.length === before + 1, "Uncertain receipt allowed an unacknowledged retry");
  });

  await scenario("malformed-positive-response-never-redeliver", async () => {
    reply = { body: null };
    const before = posts.length;
    check((await send(selected, "play")).status === "uncertain", "Malformed response permits unsafe retry");
    check((await send(selected, "play")).status === "uncertain" && posts.length === before + 1, "Malformed response redelivered");
  });

  await scenario("worker-recovery-distinguishes-before-and-after-dispatch", async () => {
    const sent = await send(selected, "play");
    const saved = (session.get(`product-actions:${tabId}`) as Array<ProductAction>).find((action) => action.id === sent.id)!;
    await removeProductActions(tabId);
    const interrupted = { ...saved, id: crypto.randomUUID(), status: "sending" };
    session.set(`product-actions:${tabId}`, [interrupted, { id: crypto.randomUUID(), key: "preparation-only", action: "watch", status: "preparing" }]);
    const recovered = await state();
    check(recovered[0]!.status === "uncertain" && recovered[1]!.status === "failed", "Worker recovery confused dispatch ownership");
    const before = posts.length;
    check((await send(selected, "play")).id === interrupted.id && posts.length === before, "Restarted worker redelivered an uncertain action");
  });

  await scenario("tab-cleanup-during-native-response", async () => {
    const entered = deferred();
    const release = deferred();
    reply = { body: { opened: true }, entered, release };
    const pending = send(selected, "play");
    await entered.promise;
    await removeProductActions(tabId);
    release.resolve();
    await rejected(pending, "Страница изменилась");
    check((await state()).length === 0, "Late native response resurrected a removed tab intent");
  });

  await scenario("tab-cleanup-during-session-write", async () => {
    const entered = deferred();
    const release = deferred();
    storageGate = { entered, release };
    const before = posts.length;
    const pending = send(selected, "play");
    await entered.promise;
    const cleanup = removeProductActions(tabId);
    release.resolve();
    await cleanup;
    await rejected(pending, "Страница изменилась");
    check(posts.length === before && (await state()).length === 0, "Storage race revived or dispatched a cleared intent");
  });

  await scenario("stale-page-and-track-selection-rejected-before-dispatch", async () => {
    const before = posts.length;
    check((await send({ ...selected, pageUrl: "https://example.org/another-film" }, "play")).status === "failed", "Old popup page was accepted");
    check((await send({ ...selected, audioIds: selected.subtitleIds }, "play")).status === "failed", "Wrong track kind was silently dropped");
    check(posts.length === before, "Invalid exact selection reached the native helper");
  });

  await scenario("selected-track-disappears-between-snapshot-and-dispatch", async () => {
    const saved = structuredClone(session.get(`tab:${tabId}`));
    const before = posts.length;
    tabReadHook = () => {
      const current = session.get(`tab:${tabId}`) as { resources: Array<{ id: string }> };
      current.resources = current.resources.filter((resource) => resource.id !== selected.audioIds[0]);
    };
    try {
      check((await send(selected, "play")).status === "failed" && posts.length === before,
        "A job retained an audio track absent from its document bindings");
    } finally {
      session.set(`tab:${tabId}`, saved);
      tabReadHook = undefined;
    }
  });

  await scenario("document-replacement-and-unknown-identity", async () => {
    const before = posts.length;
    frames.get(4)!.documentId = "replacement-document-4";
    await addCapture(tabId, 4, { kind: "video", url: mediaUrl, provider: "unknown", detectedAt: Date.now() }, "replacement-document-4");
    check((await send(selected, "play")).status === "failed" && posts.length === before, "Old popup selection targeted the replacement document");
    const replacement = (await readTabState(tabId)).resources.find((resource) => resource.documentId === "replacement-document-4")!;
    check(replacement.id !== selected.sourceId, "Opaque source identity survived document replacement");
    check((await send({ ...selected, sourceId: replacement.id }, "play")).status === "sent" && posts.length === before + 1, "New document inherited the old result or failed to dispatch");
    await addCapture(tabId, 8, { kind: "video", url: mediaUrl, provider: "unknown", detectedAt: Date.now() });
    const unknown = (await readTabState(tabId)).resources.find((resource) => resource.frameId === 8)!;
    const failure = await send({ ...selected, sourceId: unknown.id }, "play");
    check(failure.status === "failed" && failure.error?.includes("Обновите страницу") && posts.length === before + 1, "Unknown document identity lacks a concrete recovery or reached native dispatch");
  });

  await scenario("youtube-without-content-receiver", async () => {
    tabUrl = "https://www.youtube.com/watch?v=aO_U1RwJMDk&list=WL&index=1";
    frames.set(0, { url: tabUrl, documentId: "youtube-document", media: ["blob:youtube-fixture"] });
    missingReceiver = true;
    const before = posts.length;
    try {
      const action = await send({ tabId, pageUrl: tabUrl, audioIds: [], subtitleIds: [] }, "play");
      check(action.status === "sent" && posts.length === before + 1 && posts.at(-1)!.path === "/play",
        "YouTube without content receiver failed before native dispatch: " + action.error);
    } finally {
      missingReceiver = false;
    }
  });

  await scenario("youtube-qbutt-actions-rejected-without-capture", async () => {
    const before = posts.length;
    const reads = scriptReads;
    const youtube: ProductSelection = { tabId, pageUrl: tabUrl, audioIds: [], subtitleIds: [] };
    for (const action of ["watch", "download"] as const) {
      const rejected = await send(youtube, action);
      check(rejected.status === "failed" && rejected.error?.includes("qplay"), "Unsupported YouTube action was accepted");
    }
    check(posts.length === before && scriptReads === reads, "Unsupported YouTube handoff read media or reached native helper");
  });

  for (const change of ["document", "media", "spa", "origin"] as const) {
    await scenario("youtube-" + change + "-changes-before-dispatch", async () => {
      tabUrl = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
      frames.set(0, { url: tabUrl, documentId: "youtube-document", media: ["blob:youtube-fixture"] });
      const youtube: ProductSelection = { tabId, pageUrl: tabUrl, audioIds: [], subtitleIds: [] };
      const before = posts.length;
      const reads = scriptReads;
      cookieReadHook = () => {
        if (change === "document") frames.get(0)!.documentId = "replacement-youtube-document";
        if (change === "media") frames.get(0)!.media = ["blob:replacement-video"];
        if (change === "spa") tabUrl = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
        if (change === "origin") tabUrl = "https://example.org/unrelated";
      };
      const action = await send(youtube, "play");
      check(action.status === "failed" && posts.length === before, "Changed YouTube capture reached native dispatch");
      if (change === "spa" || change === "origin") {
        check(scriptReads === reads + 1, "Changed page received another script injection");
      }
    });
  }

  await scenario("youtube-player-single-owner-and-spa-selection", async () => {
    const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
    tabUrl = url;
    frames.set(0, { url, documentId: "youtube-document", media: ["blob:youtube-fixture"] });
    const youtube: ProductSelection = { tabId, pageUrl: url, audioIds: [], subtitleIds: [] };
    const before = posts.length;
    const first = await send(youtube, "play");
    check(first.status === "sent" && posts.at(-1)!.path === "/play" && posts.at(-1)!.body.start === 42.25, "YouTube lost its original playback path or current position");
    check((await send(youtube, "play")).id === first.id && posts.length === before + 1, "YouTube player dispatched twice");
    tabUrl = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
    frames.get(0)!.url = tabUrl;
    check((await send({ ...youtube, pageUrl: tabUrl }, "play")).status === "sent" && posts.length === before + 2, "A new SPA video reused the previous action");
  });

  for (const kind of ["hls", "video"] as const) await scenario(`${kind}-cancel-cleanup-failure-stays-visible-after-drain`, async () => {
    const job: DownloadJob = {
      container: "mkv", createdAt: Date.now(), filename: "cleanup-fixture.mkv", id: `cleanup-fault-${kind}`,
      inputs: [{ headers: [], kind, role: "media", url: NATIVE_BRIDGE_URL + (kind === "hls" ? "/cleanup-fixture.m3u8" : "/cleanup-fixture.mp4") }],
      pageUrl, subtitles: [], tabId, title: "Generated cleanup fixture",
    };
    await addQueueJobs([job], "downloading");
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const files = new Set<string>();
    const events: string[] = [];
    const controller = new AbortController();
    mediaGate = { entered: deferred(), release: deferred() };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
      async getDirectory() {
        return { async getDirectoryHandle() {
          return {
            async getFileHandle(name: string) {
              files.add(name);
              return { async createWritable() {
                return new WritableStream({ abort() { events.push("abort:" + name); } });
              } };
            },
            async removeEntry(name: string) {
              events.push("remove:" + name);
              if (name.endsWith(".partial")) throw new Error("Injected output cleanup failure");
              files.delete(name);
            },
          };
        } };
      },
    } } });
    runtimeHook = async (message) => {
      if (message.type === "engine:release") events.push("release");
      if (message.type === "queue:update" && message.status) {
        await updateQueueItem(job.id, message.status as QueueStatus, 0, message.error);
      }
      if (message.type !== "queue:update" || !["canceled", "completed", "failed"].includes(message.status ?? "")) return;
      events.push("terminal:" + message.status);
      check(message.status === "failed" && message.error?.includes("Injected output cleanup failure"),
        "Cleanup failure was hidden behind a successful cancellation or completion");
      check((kind !== "hls" || events.includes(`remove:${job.id}.input-0.media`)) && events.includes("release"),
        "Terminal status preceded staging cleanup or replay release");
    };
    try {
      const downloading = runDownload(job, controller.signal);
      await mediaGate.entered.promise;
      controller.abort();
      await downloading;
      check(events.includes(`abort:${job.id}.partial`) && (kind !== "hls" || events.includes(`abort:${job.id}.input-0.media`)),
        "Cancellation did not close the pending output and staging writers");
      check(files.size === 1 && files.has(`${job.id}.partial`),
        "An output cleanup failure prevented cleanup of the other owned staging files");
      check(events.at(-1) === "terminal:failed", "Cleanup did not own the final terminal notification");
      await updateQueueItem(job.id, "downloading", 0.75);
      await updateQueueItem(job.id, "canceled", 0);
      const failed = (await readQueue()).items.find((item) => item.job.id === job.id)!;
      check(failed.status === "failed" && failed.error?.includes("Injected output cleanup failure"),
        "Late progress or cancellation erased a terminal cleanup failure");
      await replaceQueueJob(job.id, job);
      check((await readQueue()).items.find((item) => item.job.id === job.id)?.status === "queued",
        "Preserving terminal state blocked an explicit queue retry");
    } finally {
      mediaGate.release.resolve();
      mediaGate = undefined;
      runtimeHook = undefined;
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  console.log(JSON.stringify({ status: "passed", scenarios: passed, nativePosts: posts.length,
    boundary: "isolated production handlers and loopback HTTP; no GUI, installed extension, real playback/download or qbutt accepted ACK" }));
} finally {
  clearTimeout(deadline);
  globalThis.fetch = realFetch;
  await server.stop(true);
}
