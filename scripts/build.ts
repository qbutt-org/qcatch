import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { generateIcons } from "./icons.ts";
import { copyExtensionLicenses } from "./licenses.ts";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await generateIcons();

const result = await Bun.build({
  entrypoints: [
    resolve(root, "src/background/index.ts"),
    resolve(root, "src/content/bridge.ts"),
    resolve(root, "src/content/sniffer.ts"),
    resolve(root, "src/offscreen/index.ts"),
    resolve(root, "src/popup/index.tsx"),
    resolve(root, "src/connection/parser.ts"),
  ],
  format: "esm",
  minify: false,
  naming: "[dir]/[name].[ext]",
  outdir: dist,
  root: resolve(root, "src"),
  sourcemap: "external",
  splitting: false,
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
  throw new Error("Extension build failed");
}

const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8")) as { version: string; key: string };
manifest.version = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version as string;
const extensionId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
  .map((value) => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join("");
if (extensionId !== (await readFile(resolve(root, "release/extension-id.txt"), "utf8")).trim()) {
  throw new Error("Extension manifest key and native host ID differ");
}
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const runtimeFiles: Array<[string, string]> = [
  ["src/twitter/offscreen.js", "twitter/offscreen.js"],
  ["src/twitter/gif-converter.js", "twitter/gif-converter.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/index.js", "vendor/ffmpeg/index.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js", "vendor/ffmpeg/classes.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/const.js", "vendor/ffmpeg/const.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js", "vendor/ffmpeg/errors.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/types.js", "vendor/ffmpeg/types.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/utils.js", "vendor/ffmpeg/utils.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js", "vendor/ffmpeg/worker.js"],
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", "vendor/ffmpeg-core/ffmpeg-core.js"],
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "vendor/ffmpeg-core/ffmpeg-core.wasm"],
];
await Promise.all([
  cp(resolve(root, "src/static/icons"), resolve(dist, "icons"), { recursive: true }),
  cp(resolve(root, "src/_locales"), resolve(dist, "_locales"), { recursive: true }),
  cp(resolve(root, "src/popup/index.html"), resolve(dist, "popup/index.html")),
  cp(resolve(root, "src/popup/popup.css"), resolve(dist, "popup/popup.css")),
  cp(resolve(root, "src/popup/youtube.css"), resolve(dist, "popup/youtube.css")),
  cp(resolve(root, "src/offscreen/index.html"), resolve(dist, "offscreen/index.html")),
  cp(resolve(root, "src/connection/parser.html"), resolve(dist, "connection/parser.html")),
  copyExtensionLicenses(resolve(dist, "licenses")),
  ...runtimeFiles.map(async ([source, destination]) => {
    const output = resolve(dist, destination);
    await mkdir(dirname(output), { recursive: true });
    await cp(resolve(root, source), output);
  }),
]);
