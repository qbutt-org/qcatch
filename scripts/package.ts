import { mkdir, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
const { version } = await Bun.file(resolve(root, "package.json")).json() as { version: string };
const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("Extension build failed");

const files: Record<string, Uint8Array> = {};
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (!entry.name.endsWith(".map")) files[relative(dist, path).replaceAll("\\", "/")] = await Bun.file(path).bytes();
  }
}

await collect(dist);
await mkdir(resolve(root, "artifacts"), { recursive: true });
const output = resolve(root, "artifacts", `qcatch-${version}-extension.zip`);
await Bun.write(output, zipSync(files, { level: 9 }));
console.log(output);
