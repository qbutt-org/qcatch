import { handleIntegration, resolveCapture } from "../src/background/integration.ts";
import { removeProductActions } from "../src/background/product-actions.ts";
import { addCapture, readTabState, updatePage } from "../src/background/state.ts";
import type { IntegrationMessage, ProductAction, ProductSelection } from "../src/shared/integration.ts";
import { NATIVE_BRIDGE_URL } from "../src/shared/native.ts";

// Runs production background/session handlers against isolated browser metadata and
// a real loopback HTTP fixture. It never connects to the installed helper or fetches media.
const tabId = 71;
const pageUrl = "https://example.org/sintel";
const mediaUrl = "https://media.w3.org/2010/05/sintel/trailer.mp4";
const session = new Map<string, unknown>();
const frames = new Map<number, { url: string; documentId: string; media: string[] }>();
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let tabUrl = pageUrl;
let cookieFailure = false;
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

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    check(request.headers.get("X-Qcatch") === "1", "Native request lost its extension marker");
    const path = new URL(request.url).pathname;
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
      const identity = frames.get(options!.frameId);
      check(identity, "Missing selected frame");
      check(!options?.documentId || identity.documentId === options.documentId, "capture_expired");
      return structuredClone(identity);
    },
  },
  scripting: { async executeScript() { return [{ result: { url: tabUrl, time: 42.25 } }]; } },
  cookies: { async getAll() {
    if (cookieFailure) throw new Error("Injected preparation failure");
    return [];
  } },
  action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
  runtime: { async sendMessage() {} },
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
    await addCapture(tabId, frameId, { kind, url, provider: "unknown", detectedAt: Date.now() }, `document-${frameId}`);
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

  console.log(JSON.stringify({ status: "passed", scenarios: passed, nativePosts: posts.length,
    boundary: "isolated production handlers and loopback HTTP; no GUI, installed extension, real playback/download or qbutt accepted ACK" }));
} finally {
  clearTimeout(deadline);
  globalThis.fetch = realFetch;
  await server.stop(true);
}
