import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { zipSync } from "fflate";
import { buildRuntimeSourceArchive, copyNativeLicenses } from "./licenses.ts";

const root = resolve(import.meta.dir, "..");
const artifacts = join(root, "artifacts");
const { version } = await Bun.file(join(root, "package.json")).json() as { version: string };
if (process.argv[2] !== `v${version}` || process.argv.length !== 3 || process.platform !== "win32") {
  throw new Error(`Build on Windows: bun run release:build -- v${version}`);
}

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await process.exited !== 0) throw new Error(`Release command failed: ${command.join(" ")}`);
}

await run(["bun", "run", "check"]);
await run(["bun", "run", "bridge:build"]);
await run(["bun", "run", "package"]);
await mkdir(artifacts, { recursive: true });
const bundle = join(artifacts, "qcatch");
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await cp(join(root, "bridge/dist/qcatch.exe"), join(bundle, "qcatch.exe"));
await cp(join(root, "dist"), join(bundle, "extension"), { recursive: true, filter: (path) => !path.endsWith(".map") });
for (const name of ["LICENSE", "LICENSE.MIT", "LICENSE.GPL-2.0", "THIRD_PARTY_NOTICES.md", "upstream-lock.json"]) {
  await cp(join(root, name), join(bundle, name));
}
await cp(join(root, "scripts/setup.html"), join(bundle, "setup.html"));
await copyNativeLicenses(join(bundle, "licenses"));
const sources = `qcatch-${version}-runtime-sources.zip`;
await buildRuntimeSourceArchive(join(artifacts, sources));

const files: Record<string, Uint8Array> = {};
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else files[relative(bundle, path).replaceAll("\\", "/")] = await Bun.file(path).bytes();
  }
}
await collect(bundle);
const portable = `qcatch-${version}-windows-x64.zip`;
await Bun.write(join(artifacts, portable), zipSync(files, { level: 9 }));
const compiler = process.env.INNO_SETUP_COMPILER
  ?? join(process.env.LOCALAPPDATA ?? "", "qbutt/dependencies/inno-setup-6.7.3/ISCC.exe");
if (!await Bun.file(compiler).exists()) throw new Error("Set INNO_SETUP_COMPILER to Inno Setup 6.7.3 ISCC.exe.");
await run([compiler, `/DAppVersion=${version}`, `/DBundleDir=${bundle}`, `/DArtifactDir=${artifacts}`, join(root, "scripts/qcatch.iss")]);

const assetNames = [`qcatch-${version}-windows-x64-setup.exe`, portable, `qcatch-${version}-extension.zip`, sources];
await cp(join(artifacts, assetNames[0]!), join(artifacts, "qcatch-setup.exe"));
await cp(join(artifacts, portable), join(artifacts, "qcatch-portable.zip"));
assetNames.push("qcatch-setup.exe", "qcatch-portable.zip");
const assets = await Promise.all(assetNames.map(async (name) => {
  const bytes = await Bun.file(join(artifacts, name)).bytes();
  return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
const manifest = {
  product: "qcatch", version, protocolVersion: 1, platform: "windows-x64",
  sourceRevision: revision.exitCode === 0 ? revision.stdout.toString().trim() : null,
  sourceWorktreeChanged: status.stdout.length > 0,
  extensionId: (await Bun.file(join(root, "release/extension-id.txt")).text()).trim(),
  nativeHost: "org.qbutt.qcatch", assets,
  userReleaseAssets: ["qcatch-setup.exe", "qcatch-portable.zip"],
  sourceRelease: { tag: `v${version}-sources`, assets: [sources] },
};
await Bun.write(join(artifacts, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const manifestHash = createHash("sha256").update(await Bun.file(join(artifacts, "release-manifest.json")).bytes()).digest("hex");
await Bun.write(join(artifacts, "SHA256SUMS"), assets.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")
  + `\n${manifestHash}  release-manifest.json\n`);
console.log(`qcatch ${version}: publish qcatch-setup.exe and optional qcatch-portable.zip from ${artifacts}`);
console.log(`Publish ${sources} separately under v${version}-sources; manifests and checksums remain local.`);
