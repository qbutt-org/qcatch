import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const bridge = resolve(import.meta.dir, "../bridge");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: bridge,
    env: { ...process.env, CARGO_INCREMENTAL: "0" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error(`Bridge build failed: ${command.join(" ")}`);
}

if (process.platform === "win32") {
  await run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(bridge, "build.ps1")]);
} else if (process.platform === "linux" && process.arch === "x64") {
  await run(["cargo", "fmt", "--all", "--", "--check"]);
  await run(["cargo", "clippy", "--locked", "--all-targets", "--jobs", "2", "--", "-D", "warnings"]);
  await run(["cargo", "build", "--locked", "--release", "--jobs", "2"]);
  await mkdir(join(bridge, "dist"), { recursive: true });
  await copyFile(join(process.env.CARGO_TARGET_DIR ?? join(bridge, "target"), "release/qcatch"), join(bridge, "dist/qcatch"));
} else {
  throw new Error("qcatch builds support Windows x64 and Linux x64.");
}
