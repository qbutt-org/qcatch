import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export async function generateIcons(): Promise<void> {
  const source = resolve("src/assets/icon.svg");
  const outputDirectory = resolve("src/static/icons");
  await mkdir(outputDirectory, { recursive: true });
  const svg = await readFile(source);
  await Promise.all([16, 32, 48, 128].map((size) =>
    sharp(svg).resize(size, size).png().toFile(resolve(outputDirectory, `icon-${size}.png`)),
  ));
}

if (import.meta.main) await generateIcons();
