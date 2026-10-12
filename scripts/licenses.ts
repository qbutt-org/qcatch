import { createHash } from "node:crypto";
import { cp, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dir, "..");
const licenseName = /^(LICENSE|COPYING|NOTICE|COPYRIGHT)([-_.].*)?$/i;

type CargoPackage = {
  name: string;
  version: string;
  source: string | null;
  license: string | null;
  repository: string | null;
  manifest_path: string;
};

type CargoMetadata = { packages: CargoPackage[] };
type SourceArchive = {
  name: string;
  revision: string;
  url: string;
  file: string;
  sha256: string;
};

function command(args: string[], cwd = root): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function licenseFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await licenseFiles(path));
    else if (entry.isFile() && licenseName.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function nativePackages(): CargoPackage[] {
  const metadata = JSON.parse(command([
    "cargo", "metadata", "--locked", "--offline", "--format-version", "1",
    "--filter-platform", "x86_64-pc-windows-msvc",
  ], join(root, "bridge"))) as CargoMetadata;
  return metadata.packages.filter((item) => item.source !== null)
    .sort((a, b) => `${a.name}-${a.version}`.localeCompare(`${b.name}-${b.version}`, "en"));
}

export async function copyExtensionLicenses(destination: string): Promise<void> {
  const sourceLock = await Bun.file(join(root, "licenses/ffmpeg-wasm-sources.json")).json() as {
    wasmSha256: string; coreVersion: string; wrapperVersion: string;
  };
  const core = await Bun.file(join(root, "node_modules/@ffmpeg/core/package.json")).json() as { version: string };
  const wrapper = await Bun.file(join(root, "node_modules/@ffmpeg/ffmpeg/package.json")).json() as { version: string };
  if (core.version !== sourceLock.coreVersion || wrapper.version !== sourceLock.wrapperVersion) {
    throw new Error("FFmpeg package versions differ from the corresponding-source lock");
  }
  const wasm = await Bun.file(join(root, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm")).bytes();
  if (sha256(wasm) !== sourceLock.wasmSha256) throw new Error("FFmpeg wasm differs from the corresponding-source lock");
  await mkdir(destination, { recursive: true });
  const copies: Array<[string, string]> = [
    ["LICENSE", "qcatch-AGPL-3.0.txt"],
    ["LICENSE.MIT", "AriesAlex-MIT.txt"],
    ["LICENSE.GPL-2.0", "GPL-2.0.txt"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["licenses/ffmpeg.wasm-MIT.txt", "ffmpeg.wasm-MIT.txt"],
    ["licenses/ffmpeg-wasm-NOTICES.txt", "ffmpeg-wasm-NOTICES.txt"],
    ["licenses/ffmpeg-wasm-sources.json", "ffmpeg-wasm-sources.json"],
    ["licenses/mediabunny-source.json", "mediabunny-source.json"],
    ["node_modules/preact/LICENSE", "Preact-MIT.txt"],
    ["node_modules/mediabunny/LICENSE", "Mediabunny-MPL-2.0.txt"],
    ["node_modules/@floating-ui/dom/LICENSE", "Floating-UI-dom-MIT.txt"],
    ["node_modules/@floating-ui/core/LICENSE", "Floating-UI-core-MIT.txt"],
    ["node_modules/@floating-ui/utils/LICENSE", "Floating-UI-utils-MIT.txt"],
    ["licenses/Tabler-Icons-MIT.txt", "Tabler-Icons-MIT.txt"],
  ];
  await Promise.all(copies.map(([source, target]) => cp(join(root, source), join(destination, target))));
}

export async function copyNativeLicenses(destination: string): Promise<void> {
  const packages = nativePackages();
  const notices = [];
  for (const item of packages) {
    const directory = dirname(item.manifest_path);
    const files = await licenseFiles(directory);
    if (files.length === 0) throw new Error(`No upstream license files: ${item.name} ${item.version}`);
    const output = join(destination, "rust-crates", `${item.name}-${item.version}`);
    const noticeFiles: string[] = [];
    for (const file of files) {
      const path = relative(directory, file);
      await mkdir(dirname(join(output, path)), { recursive: true });
      await cp(file, join(output, path));
      noticeFiles.push(path.replaceAll("\\", "/"));
    }
    notices.push({ name: item.name, version: item.version, license: item.license,
      repository: item.repository, licenseFiles: noticeFiles });
  }
  const rustDocumentation = join(command(["rustc", "--print", "sysroot"]), "share/doc/rust");
  await mkdir(join(destination, "rust-standard-library"), { recursive: true });
  await cp(join(rustDocumentation, "COPYRIGHT-library.html"), join(destination, "rust-standard-library/COPYRIGHT-library.html"));
  await cp(join(rustDocumentation, "licenses"), join(destination, "rust-standard-library/licenses"), { recursive: true });
  await Bun.write(join(destination, "rust-dependencies.json"), JSON.stringify({
    target: "x86_64-pc-windows-msvc",
    rustCompiler: command(["rustc", "--version", "--verbose"]),
    cargoLockSha256: sha256(await Bun.file(join(root, "bridge/Cargo.lock")).bytes()),
    scope: "Complete locked Windows dependency graph, including build dependencies.",
    packages: notices,
  }, null, 2) + "\n");
}

async function sourceBytes(source: SourceArchive): Promise<Uint8Array> {
  const cache = join(root, "artifacts/dependency-source-cache", source.file);
  if (await Bun.file(cache).exists()) {
    const bytes = await Bun.file(cache).bytes();
    if (sha256(bytes) !== source.sha256) throw new Error(`Source cache hash mismatch: ${source.file}`);
    return bytes;
  }
  const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Source download ${source.name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== source.sha256) throw new Error(`Source archive hash mismatch: ${source.file}`);
  await mkdir(dirname(cache), { recursive: true });
  await Bun.write(cache, bytes);
  return bytes;
}

export async function buildRuntimeSourceArchive(destination: string): Promise<void> {
  const product = await Bun.file(join(root, "package.json")).json() as { version: string };
  const sourceLock = await Bun.file(join(root, "licenses/ffmpeg-wasm-sources.json")).json() as { sources: SourceArchive[] };
  const files: Record<string, Uint8Array> = {};
  for (const source of sourceLock.sources) files[`dependencies/ffmpeg/${source.file}`] = await sourceBytes(source);
  files["dependencies/ffmpeg/sources.json"] = await Bun.file(join(root, "licenses/ffmpeg-wasm-sources.json")).bytes();
  files["dependencies/ffmpeg/BUILDING.md"] = await Bun.file(join(root, "licenses/ffmpeg-wasm-BUILDING.md")).bytes();
  files["dependencies/ffmpeg/rebuild.sh"] = await Bun.file(join(root, "licenses/ffmpeg-wasm-rebuild.sh")).bytes();

  const rustSources = [];
  const cargoLock = Bun.TOML.parse(await Bun.file(join(root, "bridge/Cargo.lock")).text()) as {
    package: Array<{ name: string; version: string; checksum?: string }>;
  };
  for (const item of nativePackages()) {
    const directory = dirname(item.manifest_path);
    const checksum = cargoLock.package.find((entry) => entry.name === item.name && entry.version === item.version)?.checksum;
    if (!checksum) throw new Error(`Missing locked source checksum: ${item.name} ${item.version}`);
    const registry = basename(dirname(directory));
    const cache = resolve(directory, "../../..", "cache", registry, `${item.name}-${item.version}.crate`);
    const bytes = await Bun.file(cache).bytes();
    if (sha256(bytes) !== checksum) throw new Error(`Cargo source hash mismatch: ${item.name}`);
    files[`dependencies/rust/${item.name}-${item.version}.crate`] = bytes;
    rustSources.push({ name: item.name, version: item.version, sha256: checksum });
  }
  files["dependencies/rust/sources.json"] = new TextEncoder().encode(JSON.stringify(rustSources, null, 2) + "\n");
  files["dependencies/rust/Cargo.lock"] = await Bun.file(join(root, "bridge/Cargo.lock")).bytes();

  const mediabunny = await Bun.file(join(root, "node_modules/mediabunny/package.json")).json() as { version: string };
  const mediabunnyLock = await Bun.file(join(root, "licenses/mediabunny-source.json")).json() as SourceArchive & {
    localPatch: { path: string; sha256: string };
  };
  if (mediabunny.version !== mediabunnyLock.revision) throw new Error("Mediabunny source version differs from installed dependency");
  const patch = await Bun.file(join(root, mediabunnyLock.localPatch.path)).bytes();
  if (sha256(patch) !== mediabunnyLock.localPatch.sha256) {
    throw new Error("Mediabunny patch differs from its source lock");
  }
  files[`dependencies/mediabunny/${mediabunnyLock.file}`] = await sourceBytes(mediabunnyLock);
  files["dependencies/mediabunny/source.json"] = await Bun.file(join(root, "licenses/mediabunny-source.json")).bytes();
  files[`dependencies/mediabunny/${basename(mediabunnyLock.localPatch.path)}`] = patch;
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  files["source-manifest.json"] = new TextEncoder().encode(JSON.stringify({
    product: "qcatch", version: product.version,
    productSource: `https://github.com/qbutt-org/qcatch/tree/v${product.version}`,
    sourceRevision: revision.exitCode === 0 ? revision.stdout.toString().trim() : null,
    sourceWorktreeChanged: command(["git", "status", "--porcelain"]).length > 0,
    files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  }, null, 2) + "\n");
  files["BUILDING.md"] = new TextEncoder().encode(
    "# qcatch runtime dependency sources\n\n"
    + "This archive contains upstream dependency sources, exact build inputs and the local Mediabunny patch. "
    + "Product source is available from the matching public Git tag and GitHub's generated source archive; "
    + "it is not duplicated here. source-manifest.json records the product revision and dependency file hashes.\n\n"
    + "## Windows product build\n\n"
    + "Install Bun, Git, the Rust MSVC toolchain, and Visual Studio Build Tools with C++ tools and Windows SDK. "
    + "Clone the public product repository and check out its release tag:\n\n"
    + "```powershell\ngit clone https://github.com/qbutt-org/qcatch.git\ncd qcatch\n"
    + `git checkout v${product.version}\n`
    + "bun install --frozen-lockfile\nbun run check\nbun run bridge:build\nbun run package\n```\n\n"
    + "The extension is generated in dist/, the Windows helper in bridge/dist/, and the extension ZIP in artifacts/. "
    + "The lockfiles select exact dependencies; installation downloads their published packages "
    + "and applies the Mediabunny patch recorded in package.json and bun.lock. "
    + "For the installer, install Inno Setup 6.7.3 and set INNO_SETUP_COMPILER to its ISCC.exe. "
    + `Run bun run release:build -- v${product.version} to build the installer, portable bundle and local metadata.\n\n`
    + "## Dependency sources\n\n"
    + "dependencies/ffmpeg contains FFmpeg WebAssembly and linked-library source archives, immutable hashes "
    + "and its build recipe; see dependencies/ffmpeg/BUILDING.md. "
    + "dependencies/mediabunny contains the unmodified upstream TypeScript source and MPL-2.0 license. "
    + "The same directory contains the Bun patch for Matroska WebVTT compatibility; "
    + "the upstream archive and patch hashes are recorded in dependencies/mediabunny/source.json. "
    + "dependencies/rust contains every crates.io package in the locked Windows dependency graph, "
    + "including original notices; hashes match Cargo.lock.\n\n"
    + `Public release source: https://github.com/qbutt-org/qcatch/tree/v${product.version}.\n`,
  );
  await Bun.write(destination, zipSync(files, { level: 0 }));
}
