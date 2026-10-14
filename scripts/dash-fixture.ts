import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Legal, reproducible static DASH for standalone browser acceptance.
const mode = Bun.argv[2];
const fixturePath = Bun.argv[3];
if (!fixturePath || (mode !== "create" && mode !== "serve")) {
  throw new Error("Usage: bun scripts/dash-fixture.ts create|serve <fixture directory> [port]");
}
const directory = resolve(fixturePath);

if (mode === "create") {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("Use an empty generated fixture directory");
  const generated = Bun.spawnSync([
    "ffmpeg", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=12",
    "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25:d=12",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=12",
    "-map", "0:v", "-map", "1:v", "-map", "2:a", "-t", "12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "50", "-keyint_min", "50", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-metadata:s:a", "language=eng",
    "-f", "dash", "-seg_duration", "2", "-use_template", "1", "-use_timeline", "1",
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    "-init_seg_name", "init-$RepresentationID$.m4s",
    "-media_seg_name", "chunk-$RepresentationID$-$Number%05d$.m4s",
    join(directory, "manifest.mpd"),
  ], { cwd: directory, windowsHide: true });
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  const manifest = Bun.file(join(directory, "manifest.mpd"));
  // Maximum area must win even when the smaller representation advertises more bandwidth.
  await Bun.write(manifest, (await manifest.text()).replace(
    /(<Representation id="1"[^>]*bandwidth=")\d+/,
    (_, prefix: string) => prefix + "5000000",
  ));
  const files = await readdir(directory);
  for (const [id, name] of [
    ["0", "maximum-video.mp4"],
    ["1", "lower-video.mp4"],
    ["2", "separate-audio.mp4"],
  ] as const) {
    const parts = [`init-${id}.m4s`, ...files.filter((name) => name.startsWith(`chunk-${id}-`)).sort()];
    const bytes = await Promise.all(parts.map((name) => Bun.file(join(directory, name)).arrayBuffer()));
    await Bun.write(join(directory, name), Buffer.concat(bytes.map((value) => Buffer.from(value))));
  }
  await Bun.write(join(directory, "en.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nUnselected English cue\n\n00:00:06.000 --> 00:00:10.000\nUnselected English ending\n");
  await Bun.write(join(directory, "ru.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nВыбранная DASH-дорожка\n\n00:00:06.000 --> 00:00:10.000\nТочный <i>русский</i> финал\n");
  console.log(JSON.stringify({ directory, duration: 12, maximum: "0:640x360", lower: "1:320x180", audio: "2:880Hz", subtitles: ["en", "ru"] }));
} else {
  const requests: Array<{ path: string; phase: string; at: number }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(Bun.argv[4] ?? 18875),
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/status") return Response.json(requests);
      if (url.pathname.startsWith("/media/") || url.pathname.startsWith("/slow/")) {
        const name = url.pathname.slice(url.pathname.indexOf("/", 1) + 1);
        if (!/^[\w.-]+$/.test(name)) return new Response("Invalid fixture path", { status: 400 });
        const file = Bun.file(join(directory, name));
        if (!await file.exists()) return new Response("Missing fixture file", { status: 404 });
        requests.push({ path: url.pathname, phase: "started", at: Date.now() });
        try {
          if (url.pathname.startsWith("/slow/") && name.endsWith(".m4s")) {
            await new Promise<void>((complete, reject) => {
              const timer = setTimeout(complete, 15000);
              request.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("Browser canceled"));
              }, { once: true });
            });
          }
          const headers = new Headers({ "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes",
            "Content-Type": name.endsWith(".mpd") ? "application/dash+xml" : name.endsWith(".vtt") ? "text/vtt; charset=utf-8" : "video/mp4" });
          const range = request.headers.get("Range")?.match(/^bytes=(\d+)-(\d*)$/);
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
            headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
            return new Response(file.slice(start, end + 1), { status: 206, headers });
          }
          return new Response(file, { headers });
        } catch (error) {
          requests.push({ path: url.pathname, phase: request.signal.aborted ? "canceled" : String(error), at: Date.now() });
          return new Response(request.signal.aborted ? "Canceled" : "Fixture error", { status: request.signal.aborted ? 499 : 500 });
        } finally {
          requests.push({ path: url.pathname, phase: "settled", at: Date.now() });
        }
      }
      const media = url.pathname === "/cancel" ? "/slow/manifest.mpd" : "/media/manifest.mpd";
      return new Response(`<!doctype html><meta charset="utf-8"><title>Generated DASH C2</title>
<style>body{font:24px system-ui;margin:80px;background:#f5f7fa;color:#17202b}video{display:none}</style>
<h1>Generated DASH C2</h1><p id="status">Loading generated static MPD</p>
<video preload="none"><track kind="subtitles" label="English" srclang="en" src="/media/en.vtt" default>
<track kind="subtitles" label="Русский" srclang="ru" src="/media/ru.vtt"></video>
<script>fetch(${JSON.stringify(media)}).then(r=>r.text()).then(t=>document.querySelector('#status').textContent='Static MPD captured: '+t.length+' bytes')</script>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
  console.log(server.url.href);
}
