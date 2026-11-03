import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type Zippable, zipSync } from "fflate";
import { buildRuntimeSourceArchive, copyNativeLicenses } from "./licenses.ts";

const root = resolve(import.meta.dir, "..");
const artifacts = join(root, "artifacts");
const { version } = await Bun.file(join(root, "package.json")).json() as { version: string };
if (process.platform !== "linux" || process.arch !== "x64" || process.argv.length !== 3 || process.argv[2] !== `v${version}`) {
  throw new Error(`Build on Linux x64: bun run release:build -- v${version}`);
}
const runtime = process.env.QCATCH_LINUX_TOOLS;
if (!runtime || !await Bun.file(join(runtime, "sources.json")).exists()) {
  throw new Error("Set QCATCH_LINUX_TOOLS to the verified shared qplay Linux tools directory, including sources.json.");
}
for (const name of ["ffmpeg", "ffprobe", "yt-dlp", "deno"]) {
  if (!await Bun.file(join(runtime, name)).exists()) throw new Error(`Linux runtime is missing ${name}.`);
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Release command failed: ${command.join(" ")}`);
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the Linux bundle: ${path}`);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Special files are not allowed in the Linux bundle: ${path}`);
  }
  return result.sort();
}

await run(["bun", "run", "check"]);
await run(["bun", "run", "bridge:build"]);
await run(["bun", "run", "package"]);
const bundle = join(artifacts, "qcatch-linux");
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await cp(join(root, "bridge/dist/qcatch"), join(bundle, "qcatch"));
await chmod(join(bundle, "qcatch"), 0o755);
await cp(join(root, "dist"), join(bundle, "extension"), { recursive: true, filter: (path) => !path.endsWith(".map") });
const tools = join(bundle, "tools");
await mkdir(tools, { recursive: true });
const toolFiles: Record<string, string> = {};
for (const source of await files(runtime)) {
  const name = relative(runtime, source);
  const destination = join(tools, name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
  const bytes = await Bun.file(destination).bytes();
  toolFiles[name] = digest(bytes);
  // The four public tools and all ELF dependencies retain executable permissions.
  if (["ffmpeg", "ffprobe", "yt-dlp", "deno"].includes(name) || (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) {
    await chmod(destination, 0o755);
  }
}
await Bun.write(join(tools, "manifest.json"), JSON.stringify({ version: "2026.10.26", files: toolFiles }, null, 2) + "\n");
for (const name of ["LICENSE", "LICENSE.MIT", "LICENSE.GPL-2.0", "THIRD_PARTY_NOTICES.md", "upstream-lock.json"]) {
  await cp(join(root, name), join(bundle, name));
}
const setupTemplate = await Bun.file(join(root, "scripts/setup.html")).text();
const setup = setupTemplate.replace('data-platform="windows-x64"', 'data-platform="linux-x64"');
if (setup === setupTemplate) throw new Error("The setup page has no build platform marker.");
await Bun.write(join(bundle, "setup.html"), setup);
await copyNativeLicenses(join(bundle, "licenses"));
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
if (revision.exitCode !== 0 || status.exitCode !== 0) throw new Error("Cannot identify the qcatch source revision.");
const sourceRevision = revision.stdout.toString().trim();
if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("Invalid qcatch source revision.");
const identity = {
  product: "qcatch", version, protocolVersion: 1, platform: "linux-x64",
  sourceRevision, sourceWorktreeChanged: status.stdout.length > 0,
};
await Bun.write(join(bundle, "build-manifest.json"), JSON.stringify(identity, null, 2) + "\n");
const inventory: Record<string, string> = {};
for (const path of await files(bundle)) inventory[relative(bundle, path)] = digest(await Bun.file(path).bytes());
await Bun.write(join(bundle, "bundle.json"), JSON.stringify({ product: "qcatch", version, protocolVersion: 1, files: inventory }, null, 2) + "\n");

const archive: Zippable = {};
for (const path of await files(bundle)) {
  const metadata = await lstat(path);
  const mode = metadata.mode & 0o111 ? 0o100755 : 0o100644;
  archive[relative(bundle, path)] = [await Bun.file(path).bytes(), { os: 3, attrs: mode << 16 }];
}
const portable = "qcatch-linux-x64.zip";
await Bun.write(join(artifacts, portable), zipSync(archive, { level: 6 }));
const sourceAsset = `qcatch-${version}-linux-runtime-sources.zip`;
await buildRuntimeSourceArchive(join(artifacts, sourceAsset));
const assets = await Promise.all([portable, `qcatch-${version}-extension.zip`, sourceAsset].map(async (name) => {
  const bytes = await Bun.file(join(artifacts, name)).bytes();
  return { name, size: bytes.length, sha256: digest(bytes) };
}));
await Bun.write(join(artifacts, "release-manifest-linux.json"), JSON.stringify({
  ...identity,
  extensionId: (await Bun.file(join(root, "release/extension-id.txt")).text()).trim(),
  nativeHost: "org.qbutt.qcatch", assets, userReleaseAssets: [portable],
  sourceRelease: { tag: `v${version}-sources`, assets: [sourceAsset] },
  runtimeSources: await Bun.file(join(runtime, "sources.json")).json(),
}, null, 2) + "\n");
await Bun.write(join(artifacts, "SHA256SUMS-linux"), assets.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n") + "\n");
console.log(`Built ${join(artifacts, portable)}. Extract and run ./qcatch --install.`);
