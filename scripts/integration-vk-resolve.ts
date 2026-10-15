import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCommand, BrowserResponse } from "../src/shared/connection.ts";
import { CAPTURE_FRAME_NAME } from "../src/connection/media.ts";

// Exercise the production native dispatch, owned-tab lifecycle and MAIN-world
// resolver against a real local HTTP server and generated H.264/AAC media.
// Browser metadata is isolated; this never touches an installed extension/profile.
const output = await mkdtemp(join(tmpdir(), "qcatch-vk-resolve-"));
const mediaPath = join(output, "generated.mp4");
const generated = Bun.spawnSync([
  "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=10",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mediaPath,
]);
if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const id = "-234920203_456239678";
const sourceUrl = `https://vkvideo.ru/video${id}`;
const mediaUrl = "https://media.example.org/720.mp4";
const selection = { episode: "2", translationId: "42", player: "VK" };
const page = { href: sourceUrl };
const tabs = new Map<number, { id: number; url: string; status: string }>();
const frames = new Map<number, string>();
const forms: URLSearchParams[] = [];
const checks: string[] = [];
let params: Record<string, unknown>;
let mode = "normal";
let nextTab = 10;
let nativeMessage!: (command: BrowserCommand) => void;
let frameMessage!: (
  message: { type: string; frameName: string; directChild: boolean },
  sender: { tab: { id: number }; frameId: number; documentId: string; url: string },
  respond: (reply?: { capture?: boolean }) => void,
) => void;
let completedNavigation!: (details: {
  tabId: number; type: string; parentFrameId: number; frameId: number; url: string; statusCode: number;
}) => void;
let nativeReply!: (response: BrowserResponse) => void;
let requestHeaders!: (details: { tabId: number; frameId: number; url: string; requestHeaders: { name: string; value: string }[] }) => void;
let inMainWorld = false;
let documentAbort = new AbortController();
let releaseResponse: (() => void) | undefined;
let enteredRequest: (() => void) | undefined;
const deadline = setTimeout(() => { throw new Error("Browser resolution integration exceeded 60 seconds"); }, 60_000);
const allohaUrl = "https://alloha.example.org/?season=1&episode=2&translation=42";
const masterUrl = "https://media.example.org/master.m3u8";
const playlistUrl = "https://media.example.org/720.m3u8";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith(".m3u8")) {
      if (request.headers.get("Origin") !== "https://alloha.example.org" || request.headers.get("Referer") !== allohaUrl) {
        return new Response("Missing source browser context", { status: 403 });
      }
      if (mode === "manifest-wait") {
        enteredRequest?.();
        await new Promise<void>(resolve => { releaseResponse = resolve; });
      }
      return new Response(mode === "manifest-large" ? " ".repeat(512 * 1024 + 1)
        : "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://media.example.org/720.mp4\n#EXT-X-ENDLIST\n", {
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    if (url.pathname === "/al_video.php") {
      check(request.method === "POST", "VK lookup lost POST");
      check(request.headers.get("X-Requested-With") === "XMLHttpRequest", "VK lookup lost request marker");
      forms.push(new URLSearchParams(await request.text()));
      enteredRequest?.();
      if (mode === "wait") await new Promise<void>(resolve => { releaseResponse = resolve; });
      if (mode === "changed") page.href = "https://vkvideo.ru/video-1_2";
      const body = mode === "large" ? " ".repeat(512 * 1024 + 1)
        : JSON.stringify({ payload: [0, [null, null, null, null, { player: { params: [params] } }]] });
      return new Response(body, { headers: { "Content-Type": "application/json; charset=windows-1251" } });
    }
    if (url.pathname === "/720.mp4") {
      check(request.headers.get("Referer") === sourceUrl, "Media referrer must be canonical and secret-free");
      check(request.headers.get("User-Agent") === "qcatch-fixture Edg/1", "Media UA was lost");
      check(request.headers.get("Cookie") === "cdn=fixture", "Media-scoped cookie was lost");
      return new Response(Bun.file(mediaPath), { headers: { "Content-Type": "video/mp4" } });
    }
    if (url.pathname === "/ru.vtt") return new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nFixture\n");
    return new Response("Unexpected fixture URL", { status: 404 });
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), page.href);
  check(["vkvideo.ru", "media.example.org"].includes(url.hostname), "Unexpected external fixture request");
  if (url.pathname === "/al_video.php") check(init?.credentials === "include", "VK lookup lost browser session");
  if (inMainWorld && url.pathname.endsWith(".m3u8")) {
    check(init?.credentials === "same-origin", "Anonymous cross-origin HLS acquired an unrelated credential mode");
    init = { ...init, headers: { ...init?.headers, Origin: "https://alloha.example.org", Referer: allohaUrl },
      signal: AbortSignal.any([init!.signal!, documentAbort.signal]) };
  }
  const response = await realFetch(`${server.url.origin}${url.pathname}${url.search}`, init);
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}) as typeof fetch;

Object.defineProperty(globalThis, "location", { value: page });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "qcatch-fixture Edg/1" } });
Object.defineProperty(globalThis, "document", { value: {
  createElement: () => ({ innerHTML: "", get value() { return this.innerHTML; } }),
} });
Object.defineProperty(globalThis, "window", { value: { name: CAPTURE_FRAME_NAME } });

const unusedEvent = { addListener() {} };
const nativePort = {
  onDisconnect: unusedEvent,
  onMessage: { addListener(listener: typeof nativeMessage) { nativeMessage = listener; } },
  postMessage(message: BrowserResponse | { type: string }) {
    if ("id" in message) nativeReply(message);
  },
};

function announceFrame(tabId: number, url: string, frameId: number, frameName: string, directChild: boolean): boolean {
  let capture = false;
  frameMessage({ type: "frame:ready", frameName, directChild }, { tab: { id: tabId }, frameId, documentId: `document-${frameId}`, url }, reply => {
    capture = reply?.capture === true;
  });
  return capture;
}

Object.defineProperty(globalThis, "chrome", { value: {
  runtime: {
    connectNative() { return nativePort; },
    onMessage: { addListener(listener: typeof frameMessage) { frameMessage = listener; } },
    onStartup: unusedEvent, onInstalled: unusedEvent,
  },
  alarms: { onAlarm: unusedEvent, async create() {} },
  windows: { async getAll() { return [{ id: 1, focused: true, incognito: false }]; } },
  tabs: {
    async create(options: { url: string; active: boolean }) {
      check(!options.active, "Resolve focused its tab");
      const tab = { id: nextTab++, url: options.url, status: "complete" };
      tabs.set(tab.id, tab);
      return tab;
    },
    async update(tabId: number, options: { url: string; muted: boolean }) {
      check(options.muted, "Resolve did not mute before navigation");
      tabs.get(tabId)!.url = options.url;
      page.href = options.url;
      announceFrame(tabId, options.url, 0, "", true);
    },
    async get(tabId: number) { return tabs.get(tabId); },
    async remove(tabId: number) { tabs.delete(tabId); frames.delete(tabId); documentAbort.abort(); },
    async sendMessage(tabId: number, message: { type: string; url?: string }, target: { frameId: number }) {
      if (message.type === "frame:mount") {
        frames.set(tabId, message.url!);
        page.href = message.url!;
        check(!announceFrame(tabId, message.url!, 2, "source-player", true), "Original iframe acquired our capture lease");
        check(!announceFrame(tabId, message.url!, 4, CAPTURE_FRAME_NAME, false), "Nested iframe acquired our capture lease");
        check(!announceFrame(tabId, "https://vkvideo.ru/video-1_2", 5, CAPTURE_FRAME_NAME, true), "Another URL acquired our capture lease");
        completedNavigation({ tabId, type: "sub_frame", parentFrameId: 0, frameId: 2, url: message.url!, statusCode: 503 });
        completedNavigation({ tabId, type: "sub_frame", parentFrameId: 0, frameId: 7, url: message.url!,
          statusCode: mode === "failed-frame" ? 503 : 200 });
        check(announceFrame(tabId, message.url!, 7, CAPTURE_FRAME_NAME, true), "Owned iframe did not acquire capture");
        if (mode === "duplicate-frame") {
          check(!announceFrame(tabId, message.url!, 8, CAPTURE_FRAME_NAME, true), "Two owned iframe identities were accepted");
        }
        return { mounted: true };
      }
      if (message.type === "prepare") return { url: frames.get(tabId), embedded: false };
      if (message.type === "capture:start") {
        requestHeaders({ tabId, frameId: 7, url: masterUrl, requestHeaders: [
          { name: "Origin", value: "https://alloha.example.org" }, { name: "Referer", value: allohaUrl },
        ] });
        (frameMessage as Function)({ type: "capture", payload: { url: masterUrl, contentType: "application/vnd.apple.mpegurl",
          body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720\n720.m3u8\n",
          initiator: allohaUrl } }, { tab: { id: tabId }, frameId: 7, documentId: "document-7", url: allohaUrl }, () => undefined);
        return { started: true };
      }
      check(message.type === "ready", "Exact VK resolve fell back to generic player guessing");
      return { ready: true, url: target.frameId === 7 ? frames.get(tabId) : tabs.get(tabId)?.url };
    },
  },
  cookies: { async getAll({ url }: { url: string }) {
    if (url === playlistUrl) return [];
    check(url === mediaUrl, "Resolve requested unrelated page cookies");
    return [{ name: "cdn", value: "fixture", domain: "media.example.org", path: "/", secure: true, hostOnly: true }];
  } },
  scripting: { async executeScript(script: { world: string; target: { frameIds?: number[]; documentIds?: string[] }; func: Function; args: unknown[] }) {
    check(script.world === "MAIN", "VK lookup left MAIN world");
    if (script.target.documentIds) {
      check(script.target.documentIds.length === 1 && script.target.documentIds[0] === "document-7", "Manifest left its confirmed document");
      inMainWorld = true;
      try { return [{ documentId: mode === "manifest-document-changed" ? "document-replaced" : "document-7", result: await script.func(...script.args) }]; }
      finally { inMainWorld = false; }
    }
    check(script.target.frameIds?.length === 1, "VK lookup was not scoped to one frame");
    return mode === "missing-script" ? [] : [{ result: await script.func(...script.args) }];
  } },
  webRequest: {
    onCompleted: { addListener(listener: typeof completedNavigation) { completedNavigation = listener; } },
    onBeforeSendHeaders: { addListener(listener: typeof requestHeaders) { requestHeaders = listener; } },
  },
} });

await import("../src/connection/background.ts");
let commandId = 0;
function resolve(url = sourceUrl, referrer?: string) {
  return new Promise<BrowserResponse>(complete => {
    nativeReply = complete;
    nativeMessage({ id: ++commandId, method: "resolve", kind: "video", url, selection,
      ...(referrer ? { referrer } : {}) });
  });
}

function reset() {
  mode = "normal";
  documentAbort = new AbortController();
  params = { oid: -234920203, vid: 456239678, md_title: "Generated episode 2",
    url360: "https://media.example.org/360.mp4", url720: mediaUrl,
    subs: [{ title: "Russian", lang: "ru", url: "https://media.example.org/ru.vtt" }] };
}

try {
  reset();
  const response = await resolve();
  const result = response.result as { url: string; sourceUrl: string; quality: string;
    headers: Record<string, string>; selection: unknown; subtitles: { url: string; language: string }[] };
  check(!response.error && result.url === mediaUrl && result.quality === "720p", "Maximum muxed MP4 was not selected");
  check(result.sourceUrl === sourceUrl && JSON.stringify(result.selection) === JSON.stringify(selection), "Exact identity changed");
  check(result.subtitles[0]?.language === "ru", "Subtitle language was lost");
  const media = await fetch(result.url, { headers: result.headers });
  const received = join(output, "received.mp4");
  await writeFile(received, Buffer.from(await media.arrayBuffer()));
  check((await (await fetch(result.subtitles[0]!.url)).text()).startsWith("WEBVTT"), "Subtitle delivery failed");
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-of", "json", received]);
  const streams = JSON.parse(probe.stdout.toString()).streams as { codec_type: string; width?: number; height?: number }[];
  check(probe.exitCode === 0 && streams.some(s => s.width === 1280 && s.height === 720)
    && streams.some(s => s.codec_type === "audio"), "Received media lost resolution or audio");
  const decoded = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", received, "-f", "null", "-"]);
  check(decoded.exitCode === 0, "Received media failed full decode");
  checks.push("exact page -> native descriptor -> generated 720p H.264/AAC full decode and subtitle");

  reset();
  const embedded = await resolve(`https://vkvideo.ru/video_ext.php?oid=-234920203&id=456239678&hash=fixture&access_key=fixture-access&list=fixture-list`, "https://yani.tv/");
  check(!embedded.error && (embedded.result as typeof result).sourceUrl === sourceUrl, "Embedded exact VK identity failed");
  check(forms.at(-1)?.get("access_key") === "fixture-access" && forms.at(-1)?.get("list") === "fixture-list", "VK access parameters were lost");
  check(!JSON.stringify(embedded.result).includes("fixture-access"), "Private access key leaked into descriptor");
  checks.push("exact Yummy iframe -> selected frame -> access_key/list -> canonical secret-free identity");
  checks.push("original same-URL iframe and nested named iframe cannot replace the owned direct-child sender");

  for (const rejectedMode of ["duplicate-frame", "failed-frame"]) {
    reset();
    mode = rejectedMode;
    const rejected = await resolve(`https://vkvideo.ru/video_ext.php?oid=-234920203&id=456239678`, "https://yani.tv/");
    check(rejected.error?.code === (rejectedMode === "duplicate-frame" ? "selection_unavailable" : "source_unavailable"),
      `${rejectedMode} lost its exact failure category`);
    check(!rejected.result && tabs.size === 0, `${rejectedMode} returned media or leaked the helper tab`);
    checks.push(rejectedMode);
  }

  for (const [name, mutate] of [
    ["wrong video", () => { params.vid = 999; }],
    ["DRM", () => { params.drm = true; }],
    ["live", () => { params.live = 2; }],
    ["no muxed MP4", () => { delete params.url360; delete params.url720; params.hls = "https://media.example.org/master.m3u8"; }],
    ["invalid maximum does not downgrade", () => { params.url720 = "http://media.example.org/720.mp4"; }],
    ["private media URL", () => { params.url720 = "https://127.0.0.1/720.mp4"; }],
    ["private subtitle URL", () => { params.subs = [{ title: "bad", url: "https://127.0.0.1/ru.vtt" }]; }],
    ["changed page", () => { mode = "changed"; }],
    ["bounded response", () => { mode = "large"; }],
    ["missing MAIN result", () => { mode = "missing-script"; }],
  ] as const) {
    reset();
    mutate();
    const rejected = await resolve();
    check(rejected.error && !rejected.result, `${name} was accepted`);
    check(tabs.size === 0, `${name} leaked its owned tab`);
    checks.push(name);
  }

  reset();
  mode = "wait";
  const entered = new Promise<void>(complete => { enteredRequest = complete; });
  const pending = resolve();
  await entered;
  nativeMessage({ id: commandId, method: "cancel" });
  const canceled = await pending;
  check(canceled.error?.code === "canceled" && tabs.size === 0, "Cancellation did not close the owned tab");
  releaseResponse?.();
  checks.push("cancel in pending MAIN HTTP request closes owned tab without success");
  releaseResponse?.();
  enteredRequest = undefined;

  const resolveHls = () => new Promise<BrowserResponse>(complete => {
    nativeReply = complete;
    nativeMessage({ id: ++commandId, method: "resolve", kind: "video", url: allohaUrl,
      referrer: "https://yani.tv/", selection: { season: "1", episode: "2", translationId: "42", player: "alloha" } });
  });
  reset();
  const hls = await resolveHls();
  check(!hls.error && (hls.result as { url: string }).url === playlistUrl,
    `HLS did not retain maximum quality through its source document: ${hls.error?.code ?? "unexpected media"} ${hls.error?.message ?? ""}`);
  check(tabs.size === 0, "HLS success leaked its helper tab");
  checks.push("captured HLS master -> exact-document MAIN child fetch with browser Origin/Referer -> maximum quality");

  for (const [failureMode, code] of [["manifest-large", "response_too_large"], ["manifest-document-changed", "selected_content_changed"]] as const) {
    reset();
    mode = failureMode;
    const failure = await resolveHls();
    check(failure.error?.code === code && !failure.result && tabs.size === 0, `${failureMode} returned media or lost its error/cleanup`);
    checks.push(failureMode);
  }
  reset();
  mode = "manifest-wait";
  const manifestEntered = new Promise<void>(complete => { enteredRequest = complete; });
  const manifestPending = resolveHls();
  await manifestEntered;
  nativeMessage({ id: commandId, method: "cancel" });
  const manifestCanceled = await manifestPending;
  check(manifestCanceled.error?.code === "canceled" && tabs.size === 0 && !inMainWorld, "Manifest cancellation did not drain its closed document");
  releaseResponse?.();
  checks.push("cancel MAIN manifest fetch -> close owned document -> drain injection before canceled reply");
  await writeFile(join(output, "evidence.json"), JSON.stringify({ checks, mediaBytes: (await Bun.file(received).stat()).size }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence: join(output, "evidence.json") }));
} finally {
  releaseResponse?.();
  server.stop(true);
  clearTimeout(deadline);
}
