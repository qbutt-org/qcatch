import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";

if (process.platform !== "linux") throw new Error("Run this integration on Linux.");
const portCheck = Bun.listen({ hostname: "127.0.0.1", port: 47832, socket: { data() {} } });
portCheck.stop(true);
const bundle = resolve(process.env.QCATCH_LINUX_BUNDLE ?? "artifacts/qcatch-linux");
const archive = resolve(process.env.QCATCH_LINUX_ARCHIVE ?? "artifacts/qcatch-linux-x64.zip");
const previous = process.env.QCATCH_LINUX_PREVIOUS_EXECUTABLE;
if (!previous) throw new Error("Set QCATCH_LINUX_PREVIOUS_EXECUTABLE to the generated previous-version helper.");
const home = await mkdtemp(join(tmpdir(), "qcatch Linux update "));
await chmod(home, 0o700);
const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
const data = join(environment.XDG_DATA_HOME, "qcatch");
const executable = join(data, "app/qcatch");
let passed = 0;
const deadline = setTimeout(async () => {
  console.error(`Linux update integration timed out; diagnostics: ${home}`);
  if (await Bun.file(executable).exists()) await run([executable, "--stop"]).catch(console.error);
  process.exit(1);
}, 180_000);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed++;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function run(args: string[], expected = 0, reason?: string): Promise<string> {
  const child = Bun.spawn(args, { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  check(code === expected, `${args[1]} exited ${code}: ${stderr}`);
  if (reason) check(stderr.includes(reason), `${args[1]} expected ${reason}, received: ${stderr}`);
  return stdout;
}

async function parentId(): Promise<number> {
  const parent = Bun.spawn(["/bin/true"], { stdout: "ignore", stderr: "ignore" });
  await parent.exited;
  return parent.pid;
}

try {
  const current = JSON.parse(await run([join(bundle, "qcatch"), "--version-json"]));
  const old = JSON.parse(await run([previous, "--version-json"]));
  check(current.product === "qcatch" && old.product === "qcatch" && current.version !== old.version, "Update fixture versions are equal or invalid");
  const oldBundle = join(home, "previous-bundle");
  await cp(bundle, oldBundle, { recursive: true });
  await cp(previous, join(oldBundle, "qcatch"));
  await chmod(join(oldBundle, "qcatch"), 0o700);
  const identity = await Bun.file(join(oldBundle, "build-manifest.json")).json();
  identity.version = old.version;
  identity.sourceWorktreeChanged = true;
  await writeFile(join(oldBundle, "build-manifest.json"), JSON.stringify(identity));
  const manifest = await Bun.file(join(oldBundle, "bundle.json")).json();
  manifest.version = old.version;
  for (const name of ["qcatch", "build-manifest.json"]) manifest.files[name] = digest(await readFile(join(oldBundle, name)));
  await writeFile(join(oldBundle, "bundle.json"), JSON.stringify(manifest));

  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const desktop = join(home, "Desktop");
  await mkdir(desktop);
  const payload = join(desktop, "keep.bin");
  await writeFile(payload, new Uint8Array([4, 8, 15, 16, 23, 42]));
  const payloadHash = digest(await readFile(payload));
  const job = { id: "d26f1200-3ed0-4b87-a5ed-ff7d660e3cb9", url: "https://www.youtube.com/watch?v=Fixture1234", title: "Preserved generated payload", format: "mp4", start: 0, end: null, status: "completed", progress: 1, filename: "keep.bin", filenames: ["keep.bin"] };
  await writeFile(join(data, "jobs.json"), JSON.stringify([job]), { mode: 0o600 });
  await run([join(oldBundle, "qcatch"), "--install"]);
  check(JSON.parse(await run([executable, "--version-json"])).version === old.version, "Previous version was not installed");
  const installedInode = (await stat(executable)).ino;
  const unowned = join(data, "app/unowned.fixture");
  await writeFile(unowned, "preserve this generated file");
  for (const command of [[join(oldBundle, "qcatch"), "--install"], [executable, "--uninstall"]]) {
    await run(command, 1, "Unowned file in qcatch bundle");
    check((await stat(executable)).ino === installedInode, "An ownership rejection replaced the installed executable");
    check(await readFile(unowned, "utf8") === "preserve this generated file", "An ownership rejection removed an unowned file");
  }
  await rm(unowned);

  const updates = join(data, "updates");
  await mkdir(updates, { recursive: true, mode: 0o700 });
  await chmod(updates, 0o700);
  const original = digest(await readFile(executable));
  const faults: Array<{ name: string; bytes: Uint8Array; reason: string }> = [
    { name: "parent-path", bytes: zipSync({ "../escaped.txt": new Uint8Array([1]) }), reason: "Unsafe update path" },
    { name: "symlink", bytes: zipSync({ linked: [new TextEncoder().encode("/tmp/qcatch-update-escape"), { os: 3, attrs: 0o120777 << 16 }] }), reason: "Symlink or special file in update" },
  ];
  const duplicate = Buffer.from(zipSync({ "first0.txt": new Uint8Array([1]), "second.txt": new Uint8Array([2]) }));
  let offset = 0;
  while ((offset = duplicate.indexOf("second.txt", offset)) !== -1) {
    duplicate.write("first0.txt", offset);
    offset += 10;
  }
  faults.push({ name: "duplicate", bytes: duplicate, reason: "Duplicate update path" });
  const broken: Zippable = {};
  const invalidFiles: Record<string, string> = {};
  for (const name of ["qcatch", "extension/manifest.json", "tools/manifest.json"]) {
    const bytes = await readFile(join(bundle, name));
    broken[name] = [bytes, { os: 3, attrs: (name === "qcatch" ? 0o100755 : 0o100644) << 16 }];
    invalidFiles[name] = name === "qcatch" ? "0".repeat(64) : digest(bytes);
  }
  broken["bundle.json"] = new TextEncoder().encode(JSON.stringify({ product: "qcatch", version: current.version, protocolVersion: 1, files: invalidFiles }));
  faults.push({ name: "checksum", bytes: zipSync(broken), reason: "qcatch bundle integrity check failed" });
  for (const { name, bytes, reason } of faults) {
    const path = join(updates, `${name}.zip`);
    await writeFile(path, bytes, { mode: 0o600 });
    await run([executable, "--apply-update", path, String(await parentId())], 1, reason);
    check(digest(await readFile(executable)) === original, `Rejected ${name} archive changed the installed executable`);
    check(!(await readdir(updates)).some((entry) => entry.startsWith(".extract-")), `Rejected ${name} archive left extracted payload`);
    await rm(path);
  }
  const valid = Buffer.from(await readFile(archive));
  const footerAt = valid.length - 22;
  check(valid.readUInt32LE(footerAt) === 0x06054b50, "Generated release ZIP has an unexpected footer");
  const directoryAt = valid.readUInt32LE(footerAt + 16);
  const directorySize = valid.readUInt32LE(footerAt + 12);
  const count = valid.readUInt16LE(footerAt + 10);
  const firstLength = 46 + valid.readUInt16LE(directoryAt + 28) + valid.readUInt16LE(directoryAt + 30) + valid.readUInt16LE(directoryAt + 32);
  const repeatedHeader = valid.subarray(directoryAt, directoryAt + firstLength);
  const duplicateFooter = Buffer.from(valid.subarray(footerAt));
  duplicateFooter.writeUInt16LE(count + 1, 8);
  duplicateFooter.writeUInt16LE(count + 1, 10);
  duplicateFooter.writeUInt32LE(directorySize + firstLength, 12);
  const extra = Buffer.from(zipSync({ "unowned.fixture": new TextEncoder().encode("generated unowned payload") }));
  const extraFooterAt = extra.length - 22;
  const extraDirectoryAt = extra.readUInt32LE(extraFooterAt + 16);
  const extraDirectorySize = extra.readUInt32LE(extraFooterAt + 12);
  const extraHeader = Buffer.from(extra.subarray(extraDirectoryAt, extraFooterAt));
  extraHeader.writeUInt32LE(directoryAt, 42);
  const extraFooter = Buffer.from(valid.subarray(footerAt));
  extraFooter.writeUInt16LE(count + 1, 8);
  extraFooter.writeUInt16LE(count + 1, 10);
  extraFooter.writeUInt32LE(directorySize + extraDirectorySize, 12);
  extraFooter.writeUInt32LE(directoryAt + extraDirectoryAt, 16);
  const zip64 = Buffer.alloc(76);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(BigInt(count), 24);
  zip64.writeBigUInt64LE(BigInt(count), 32);
  zip64.writeBigUInt64LE(BigInt(directorySize), 40);
  zip64.writeBigUInt64LE(BigInt(directoryAt), 48);
  zip64.writeUInt32LE(0x07064b50, 56);
  zip64.writeBigUInt64LE(BigInt(footerAt), 64);
  zip64.writeUInt32LE(1, 72);
  for (const [name, parts, reason] of [
    ["valid-duplicate-central", [valid.subarray(0, footerAt), repeatedHeader, duplicateFooter], "Duplicate update path"],
    ["valid-extra-member", [valid.subarray(0, directoryAt), extra.subarray(0, extraDirectoryAt), valid.subarray(directoryAt, footerAt), extraHeader, extraFooter], "Unowned file in qcatch bundle"],
    ["valid-zip64-unsaturated", [valid.subarray(0, footerAt), zip64, valid.subarray(footerAt)], "ZIP64 update archives are unsupported"],
  ] as const) {
    const path = join(updates, `${name}.zip`);
    await writeFile(path, Buffer.concat(parts), { mode: 0o600 });
    await run([executable, "--apply-update", path, String(await parentId())], 1, reason);
    check((await stat(executable)).ino === installedInode && digest(await readFile(executable)) === original, `Rejected ${name} changed the installed executable`);
    check(digest(await readFile(payload)) === payloadHash, `Rejected ${name} changed downloaded payload`);
    check(!(await readdir(updates)).some((entry) => entry.startsWith(".extract-")), `Rejected ${name} left extracted payload`);
    await rm(path);
  }
  check(!await Bun.file(join(updates, "escaped.txt")).exists(), "Update path escaped its staging directory");

  const candidate = join(updates, "candidate.zip");
  await cp(archive, candidate);
  await chmod(candidate, 0o600);
  await run([executable, "--apply-update", candidate, String(await parentId())]);
  check(JSON.parse(await run([executable, "--version-json"])).version === current.version, "ZIP update did not install the current version");
  check(digest(await readFile(payload)) === payloadHash, "ZIP update changed downloaded payload");
  check((await Bun.file(join(data, "jobs.json")).json()).some((item: any) => item.id === job.id), "ZIP update removed the saved queue");
  await run([join(oldBundle, "qcatch"), "--install"], 1, "A newer qcatch version is already installed");
  check(JSON.parse(await run([executable, "--version-json"])).version === current.version, "An older installer downgraded qcatch");
  await run([executable, "--uninstall"]);
  check(!await Bun.file(executable).exists(), "Uninstall retained the application");
  check(digest(await readFile(payload)) === payloadHash, "Uninstall changed downloaded payload");
  console.log(JSON.stringify({ passed, previousVersion: old.version, installedVersion: current.version, zipUpdate: true, rejectedArchives: faults.map(({ name }) => name), downgradeRejected: true }));
} finally {
  clearTimeout(deadline);
  if (await Bun.file(executable).exists()) await run([executable, "--stop"]);
  await rm(home, { recursive: true, force: true });
}
