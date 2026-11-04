import { createHash } from "node:crypto";
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercises the real Linux executable, installation, framed Unix relay, yt-dlp,
// FFmpeg, cancellation and cleanup. Only source extraction metadata is generated;
// no external site is contacted and no browser profile is changed.
if (process.platform !== "linux") throw new Error("Run this integration on Linux.");
if (process.env.QCATCH_PRIVATE_BUS !== "1") {
  const child = Bun.spawn(["dbus-run-session", "--", process.execPath, import.meta.path], {
    env: { ...process.env, QCATCH_PRIVATE_BUS: "1" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}
const portCheck = Bun.listen({ hostname: "127.0.0.1", port: 47832, socket: { data() {} } });
portCheck.stop(true);
const bundle = resolve(process.env.QCATCH_LINUX_BUNDLE ?? "artifacts/qcatch-linux");
const source = join(bundle, "qcatch");
const home = await mkdtemp(join(tmpdir(), "qcatch Linux integration "));
await chmod(home, 0o700);
const environment = {
  ...process.env,
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
};
const data = join(environment.XDG_DATA_HOME, "qcatch");
const installed = join(data, "app/qcatch");
const desktop = join(home, "Chosen Desktop");
const id = (await Bun.file("release/extension-id.txt").text()).trim();
const origin = `chrome-extension://${id}`;
const deadline = setTimeout(async () => {
  console.error(`Linux integration timed out; diagnostic directory: ${home}`);
  if (await Bun.file(installed).exists()) await run([installed, "--stop"]).catch(console.error);
  process.exit(1);
}, 120_000);
let passed = 0;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed++;
}

async function run(args: string[], expected = 0, env = environment): Promise<string> {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  check(code === expected, `${args[1]} exited ${code}: ${stderr}`);
  return stdout;
}

async function until<T>(operation: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const value = await operation();
    if (accept(value)) return value;
    await Bun.sleep(75);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:47832${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Qcatch": "1", Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  check(response.ok, `${path}: ${JSON.stringify(value)}`);
  return value;
}

async function startingHealth(): Promise<any> {
  try { return await api("/health"); } catch (error: any) {
    if (error.code === "ConnectionRefused") return null;
    throw error;
  }
}

let slow = false;
let activeTransfers = 0;
let rejectedFormats = 0;
const media = join(home, "fixture.mp4");
const video = join(home, "fixture-video.mp4");
const audio = join(home, "fixture-audio.m4a");
const assets = new Map([["/fixture.mp4", media], ["/fixture-video.mp4", video], ["/fixture-audio.m4a", audio]]);
const requestedTracks = new Set<string>();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/blocked.mp4") {
      rejectedFormats++;
      return new Response(null, { status: 403 });
    }
    const file = assets.get(path);
    if (!file) return new Response(null, { status: 404 });
    requestedTracks.add(path);
    const bytes = await Bun.file(file).bytes();
    if (!slow) return new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) } });
    activeTransfers++;
    let offset = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await Bun.sleep(100);
        if (offset >= bytes.length) { activeTransfers--; controller.close(); return; }
        controller.enqueue(bytes.slice(offset, offset += 1024));
      },
      cancel() { activeTransfers--; },
    }), { headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) } });
  },
});
const socketPath = join(home, "broker.sock");
const broker = createServer((socket) => socket.on("data", (bytes) => socket.write(bytes)));
let fileManager: Awaited<ReturnType<typeof import("./linux-file-manager-fixture.ts").fileManagerFixture>> | undefined;

try {
  fileManager = await (await import("./linux-file-manager-fixture.ts")).fileManagerFixture();
  await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
  await writeFile(join(environment.XDG_CONFIG_HOME, "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Chosen Desktop"\n');
  const version = JSON.parse(await run([source, "--version-json"]));
  check(version.product === "qcatch" && version.protocolVersion === 1, "Product metadata changed");
  await run([source, "--install"]);
  await until(async () => fetch("http://127.0.0.1:47832/health", { headers: { "X-Qcatch": "1", Origin: origin } }).then((r) => r.ok).catch(() => false), Boolean, "installed helper");
  for (const browser of ["google-chrome", "google-chrome-for-testing", "chromium", "microsoft-edge"]) {
    const manifest = await Bun.file(join(environment.XDG_CONFIG_HOME, browser, "NativeMessagingHosts/org.qbutt.qcatch.json")).json();
    check(manifest.path === installed && manifest.allowed_origins[0] === `${origin}/`, `Incorrect ${browser} registration`);
  }
  const browserDirectory = join(home, "browser-fixture");
  await mkdir(browserDirectory);
  const launched = join(home, "browser-launched.json");
  for (const name of ["google-chrome", "chromium"]) {
    await writeFile(join(browserDirectory, name), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(launched)},JSON.stringify({browser:${JSON.stringify(name)},arguments:process.argv.slice(2)}));\n`, { mode: 0o700 });
  }
  const applications = join(environment.XDG_DATA_HOME, "applications");
  await mkdir(applications, { recursive: true });
  await writeFile(join(applications, "chromium.desktop"), `[Desktop Entry]\nType=Application\nName=Chromium fixture\nExec="${join(browserDirectory, "chromium")}" %u\nMimeType=x-scheme-handler/https;\n`);
  await writeFile(join(environment.XDG_CONFIG_HOME, "mimeapps.list"), "[Default Applications]\nx-scheme-handler/https=chromium.desktop\n");
  const connected = JSON.parse(await run([installed, "--connect-browser", "chrome"], 0, { ...environment, PATH: `${browserDirectory}:${environment.PATH}` }));
  check(connected.browser === "chrome" && connected.extensionDirectory === join(data, "app/extension"), "Browser connection metadata changed");
  const browserResult = await until(async () => Bun.file(launched).exists(), Boolean, "browser setup command");
  const selectedBrowser = browserResult ? (await Bun.file(launched).json()).browser : "none";
  check(selectedBrowser === "chromium", `Browser setup selected ${selectedBrowser} for a Chromium family default`);
  const denied = await fetch("http://127.0.0.1:47832/health", { headers: { "X-Qcatch": "1", Origin: "https://example.invalid" } });
  check(denied.status === 403, "Foreign HTTP origin was accepted");
  await run([installed, "--stop"]);
  await run([installed, "--status"], 1);

  await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const discovery = join(home, "browser-bridge.json");
  await writeFile(discovery, JSON.stringify({ pipe: socketPath, pid: process.pid }), { mode: 0o600 });
  const relayEnv = { ...environment, QBUTT_BROWSER_BRIDGE_DISCOVERY: discovery };
  // A normal helper startup clears the persistent stop request before native relays reconnect.
  const helper = Bun.spawn([installed, "--run"], { env: environment, stdout: "ignore", stderr: "pipe" });
  await until(startingHealth, (value) => value?.tools.status === "ready", "verified tools");
  const relay = Bun.spawn([installed, `${origin}/`], { env: relayEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const body = Buffer.from(JSON.stringify({ requestId: "linux-fixture", command: "hello" }));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length); body.copy(frame, 4);
  relay.stdin.write(frame);
  const reader = relay.stdout.getReader();
  let echoed = Buffer.alloc(0);
  while (echoed.length < frame.length) {
    const next = await reader.read();
    check(!next.done, "Native relay closed before its reply");
    echoed = Buffer.concat([echoed, next.value]);
  }
  check(echoed.equals(frame), "Native message framing changed");
  helper.kill("SIGKILL");
  check(await helper.exited !== 0, "The interrupted helper did not exit");
  await run([source, "--install"]);
  const closed = await Promise.race([relay.exited, Bun.sleep(1500).then(() => -1)]);
  check(closed === 0, "Native relay did not reconnect after installation");
  await until(startingHealth, (value) => value?.tools.status === "ready", "reinstalled helper");
  await chmod(discovery, 0o644);
  await run([installed, `${origin}/`], 1, relayEnv);
  await chmod(discovery, 0o600);
  await writeFile(discovery, JSON.stringify({ pipe: socketPath, pid: process.pid + 1 }));
  await run([installed, `${origin}/`], 1, relayEnv);
  await writeFile(discovery, JSON.stringify({ pipe: socketPath, pid: process.pid }));
  await chmod(socketPath, 0o644);
  await run([installed, `${origin}/`], 1, relayEnv);
  await chmod(socketPath, 0o600);
  const linkedDiscovery = join(home, "discovery-hardlink.json");
  await link(discovery, linkedDiscovery);
  await run([installed, `${origin}/`], 1, relayEnv);
  await rm(linkedDiscovery);
  const linkedSocket = join(home, "linked.sock");
  await symlink(socketPath, linkedSocket);
  await writeFile(discovery, JSON.stringify({ pipe: linkedSocket, pid: process.pid }));
  await run([installed, `${origin}/`], 1, relayEnv);
  await rm(linkedSocket);
  await writeFile(discovery, JSON.stringify({ pipe: socketPath, pid: process.pid }));
  await run([installed, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], 1, relayEnv);
  for (const invalid of [Buffer.alloc(4), Buffer.from([1, 0, 12, 0]), Buffer.from([1, 0, 0, 0, 123])]) {
    const malformed = Bun.spawn([installed, `${origin}/`], { env: relayEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    malformed.stdin.write(invalid);
    malformed.stdin.end();
    const [code, error] = await Promise.all([malformed.exited, new Response(malformed.stderr).text()]);
    check(code === 1 && error.length > 0, `Malformed native frame returned code ${code} and stderr ${JSON.stringify(error)}`);
  }
  await run([installed, "--stop"]);

  const tools = join(data, "app/tools");
  await run([join(tools, "ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-c:a", "aac", "-y", media]);
  await run([join(tools, "ffmpeg"), "-hide_banner", "-loglevel", "error", "-i", media,
    "-map", "0:v:0", "-c", "copy", video, "-map", "0:a:0", "-c", "copy", audio]);
  const metadata = {
    id: "Fixture1234", title: "Generated Linux fixture", duration: 6, extractor: "generic", extractor_key: "Generic", webpage_url: "https://www.youtube.com/watch?v=Fixture1234",
    formats: [
      { format_id: "fixture", url: `${server.url}fixture.mp4`, ext: "mp4", protocol: "http", vcodec: "h264", acodec: "aac", width: 320, height: 180, tbr: 200 },
      { format_id: "blocked", url: `${server.url}blocked.mp4`, ext: "mp4", protocol: "http", vcodec: "h264", acodec: "aac", width: 1280, height: 720, tbr: 1200 },
    ],
  };
  const info = join(home, "fixture.json");
  await writeFile(info, JSON.stringify(metadata));
  await cp(join(tools, "yt-dlp"), join(tools, "yt-dlp-pinned"));
  const toolPids = join(home, "tool-pids.txt");
  const activeToolPids = async () => {
    const pids = (await readFile(toolPids, "utf8")).trim().split("\n").map(Number);
    check(pids.every((pid) => Number.isInteger(pid) && pid > 1), "Invalid generated tool PID receipt");
    return pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch (error: any) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    });
  };
  const wrapper = `#!${process.execPath}
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(toolPids)}, process.pid + "\\n");
if (args.includes("--dump-single-json")) {
  console.log(await Bun.file(${JSON.stringify(info)}).text());
} else {
  const child = Bun.spawn([${JSON.stringify(join(tools, "yt-dlp-pinned"))}, ...args], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  await appendFile(${JSON.stringify(toolPids)}, child.pid + "\\n");
  process.exit(await child.exited);
}
`;
  await writeFile(join(tools, "yt-dlp"), wrapper, { mode: 0o700 });
  await chmod(join(tools, "yt-dlp"), 0o700);
  const manifestPath = join(tools, "manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.files["yt-dlp"] = createHash("sha256").update(wrapper).digest("hex");
  manifest.files["yt-dlp-pinned"] = createHash("sha256").update(await readFile(join(tools, "yt-dlp-pinned"))).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const worker = Bun.spawn([installed, "--run"], { env: environment, stdout: "ignore", stderr: "pipe" });
  await until(startingHealth, (value) => value?.tools.status === "ready", "fixture tools");
  const input = { url: metadata.webpage_url, cookies: [] };
  await api("/info", input);
  await until(() => api("/info", input), (value) => value.status === "ready", "source metadata");
  const published = new Map<string, string>();
  for (const [format, split] of [["mp4", false], ["mp3", false], ["mp4", true]] as const) {
    if (split) {
      metadata.formats.push(
        { format_id: "video", url: `${server.url}fixture-video.mp4`, ext: "mp4", protocol: "http", vcodec: "h264", acodec: "none", width: 320, height: 180, tbr: 250 },
        { format_id: "audio", url: `${server.url}fixture-audio.m4a`, ext: "m4a", protocol: "http", vcodec: "none", acodec: "aac", width: 0, height: 0, tbr: 128 },
      );
      await writeFile(info, JSON.stringify(metadata));
    }
    const before = rejectedFormats;
    const job = await api("/jobs", { ...input, format, start: 1, end: 4 });
    const done = await until(() => api("/jobs"), (value) => value.jobs.some((item: any) => item.id === job.id && ["completed", "failed", "canceled"].includes(item.status)), "generated download");
    const result = done.jobs.find((item: any) => item.id === job.id);
    check(result.status === "completed", `Generated ${format} failed: ${result.error}`);
    check(rejectedFormats > before, `Generated ${format} did not try the unavailable preferred format`);
    if (split) {
      check(requestedTracks.has("/fixture-video.mp4") && requestedTracks.has("/fixture-audio.m4a"), "The split download did not use both selected tracks");
    }
    const output = join(desktop, result.filename);
    await api(`/jobs/${job.id}/reveal`, {});
    await until(async () => fileManager!.uris, (uris) => uris.some((uri) => decodeURIComponent(new URL(uri).pathname) === output), "native file manager request");
    await run([join(tools, "ffmpeg"), "-hide_banner", "-loglevel", "error", "-i", output, "-f", "null", "-"]);
    const probe = JSON.parse(await run([join(tools, "ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", output]));
    check(Math.abs(Number(probe.format.duration) - 3) < 0.2, "Trimmed output duration changed");
    check(!published.has(output), "A repeated download overwrote an existing file");
    for (const [existing, hash] of published) {
      check(createHash("sha256").update(await readFile(existing)).digest("hex") === hash, "A previous output changed during a repeated download");
    }
    published.set(output, createHash("sha256").update(await readFile(output)).digest("hex"));
  }
  slow = true;
  const canceled = await api("/jobs", { ...input, format: "mp4", start: 0, end: null });
  await until(async () => activeTransfers, (value) => value > 0, "owned media transfer");
  await api(`/jobs/${canceled.id}/cancel`, {});
  const jobs = await until(() => api("/jobs"), (value) => value.jobs.some((item: any) => item.id === canceled.id && ["canceled", "failed"].includes(item.status)), "download cancellation");
  check(jobs.jobs.find((item: any) => item.id === canceled.id).status === "canceled", "Cancellation failed");
  check(!(await readdir(join(data, "temp"))).includes(canceled.id), "Canceled download left temporary payload");
  await until(activeToolPids, (pids) => pids.length === 0, "owned tool process cleanup");
  await until(async () => activeTransfers, (value) => value === 0, "canceled transfer closure");
  const stopped = await api("/jobs", { ...input, format: "mp4", start: 0, end: null });
  await until(async () => activeTransfers, (value) => value > 0, "transfer before shutdown");
  worker.kill("SIGTERM");
  check(await worker.exited === 0, "Queue worker did not drain on SIGTERM");
  const saved = await Bun.file(join(data, "jobs.json")).json();
  check(saved.find((item: any) => item.id === stopped.id).status === "canceled", "Shutdown did not persist cancellation");
  check(!(await readdir(join(data, "temp"))).includes(stopped.id), "Shutdown left temporary payload");
  await until(activeToolPids, (pids) => pids.length === 0, "owned tool cleanup after shutdown");
  const payloads = await readdir(desktop);
  await rm(join(tools, "yt-dlp-pinned"));
  await run([source, "--install"]);
  check((await readdir(desktop)).length === payloads.length, "Reinstall changed downloaded payload");
  await run([installed, "--uninstall"]);
  check(!await Bun.file(installed).exists(), "Uninstall retained application files");
  check((await readdir(desktop)).length === payloads.length, "Uninstall changed downloaded payload");
  check(await Bun.file(join(data, "jobs.json")).exists(), "Uninstall removed the saved queue");
  console.log(JSON.stringify({ passed, nativeRelay: true, generatedDownloads: ["mp4", "mp3"], cancellation: true, installReinstallUninstall: true }));
} finally {
  clearTimeout(deadline);
  let stopped = true;
  if (await Bun.file(installed).exists()) {
    try { await run([installed, "--stop"]); } catch { stopped = false; }
  }
  if (broker.listening) broker.close();
  server.stop(true);
  fileManager?.close();
  if (!stopped) throw new Error(`Could not stop the isolated helper. Diagnostics retained: ${home}`);
  await rm(home, { recursive: true, force: true });
}
