import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCommand, BrowserResponse } from "../src/shared/connection.ts";

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
let beforeRequest!: (details: unknown) => void;
let nativeReply!: (response: BrowserResponse) => void;
let releaseResponse: (() => void) | undefined;
let enteredRequest: (() => void) | undefined;
const deadline = setTimeout(() => { throw new Error("VK integration exceeded 30 seconds"); }, 30_000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
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
  return realFetch(`${server.url.origin}${url.pathname}${url.search}`, init);
}) as typeof fetch;

Object.defineProperty(globalThis, "location", { value: page });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "qcatch-fixture Edg/1" } });
Object.defineProperty(globalThis, "document", { value: {
  createElement: () => ({ innerHTML: "", get value() { return this.innerHTML; } }),
} });

const unusedEvent = { addListener() {} };
const nativePort = {
  onDisconnect: unusedEvent,
  onMessage: { addListener(listener: typeof nativeMessage) { nativeMessage = listener; } },
  postMessage(message: BrowserResponse | { type: string }) {
    if ("id" in message) nativeReply(message);
  },
};

Object.defineProperty(globalThis, "chrome", { value: {
  runtime: {
    connectNative() { return nativePort; },
    onMessage: unusedEvent, onStartup: unusedEvent, onInstalled: unusedEvent,
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
    },
    async get(tabId: number) { return tabs.get(tabId); },
    async remove(tabId: number) { tabs.delete(tabId); frames.delete(tabId); },
    async sendMessage(tabId: number, message: { type: string; url?: string }, target: { frameId: number }) {
      if (message.type === "frame:mount") {
        frames.set(tabId, message.url!);
        page.href = message.url!;
        beforeRequest({ tabId, type: "sub_frame", parentFrameId: 0, frameId: 7, url: message.url });
        return { mounted: true };
      }
      check(message.type === "ready", "Exact VK resolve fell back to generic player guessing");
      return { ready: true, url: target.frameId === 7 ? frames.get(tabId) : tabs.get(tabId)?.url };
    },
  },
  cookies: { async getAll({ url }: { url: string }) {
    check(url === mediaUrl, "Resolve requested unrelated page cookies");
    return [{ name: "cdn", value: "fixture", domain: "media.example.org", path: "/", secure: true, hostOnly: true }];
  } },
  scripting: { async executeScript(script: { world: string; target: { frameIds: number[] }; func: Function; args: unknown[] }) {
    check(script.world === "MAIN", "VK lookup left MAIN world");
    check(script.target.frameIds.length === 1, "VK lookup was not scoped to one frame");
    return mode === "missing-script" ? [] : [{ result: await script.func(...script.args) }];
  } },
  webRequest: {
    onBeforeRequest: { addListener(listener: typeof beforeRequest) { beforeRequest = listener; } },
    onCompleted: unusedEvent, onBeforeSendHeaders: unusedEvent,
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
  await writeFile(join(output, "evidence.json"), JSON.stringify({ checks, mediaBytes: (await Bun.file(received).stat()).size }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence: join(output, "evidence.json") }));
} finally {
  releaseResponse?.();
  server.stop(true);
  clearTimeout(deadline);
}
