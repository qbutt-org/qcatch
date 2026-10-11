/*
 * GIF filter adapted from cobalt:
 * https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/src/stream/ffmpeg.js
 * Copyright (C) 2024 imput, AGPL-3.0.
 * qcatch runs the filter locally through ffmpeg.wasm.
 */
import { FFmpeg } from "../vendor/ffmpeg/index.js";

const GIF_FILTER =
  "scale=-1:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse";

export class GifConverter {
  #ffmpeg = new FFmpeg();
  #loadPromise;

  constructor(onProgress) {
    if (typeof onProgress === "function") {
      this.#ffmpeg.on("progress", onProgress);
    }
  }

  async convert(url) {
    if (typeof url !== "string") {
      throw new TypeError("A media URL is required.");
    }

    await this.#ensureLoaded();

    const fileId = crypto.randomUUID();
    const inputPath = `input-${fileId}.mp4`;
    const outputPath = `output-${fileId}.gif`;

    try {
      const response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        throw new Error(`Twitter media returned HTTP ${response.status}.`);
      }

      await this.#ffmpeg.writeFile(
        inputPath,
        new Uint8Array(await response.arrayBuffer()),
      );
      const exitCode = await this.#ffmpeg.exec([
        "-i",
        inputPath,
        "-vf",
        GIF_FILTER,
        "-loop",
        "0",
        "-f",
        "gif",
        outputPath,
      ]);

      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}.`);
      }

      const output = await this.#ffmpeg.readFile(outputPath);
      if (!(output instanceof Uint8Array) || output.length === 0) {
        throw new Error("FFmpeg returned an empty GIF.");
      }

      const signature = String.fromCharCode(...output.subarray(0, 6));
      if (signature !== "GIF87a" && signature !== "GIF89a") {
        throw new Error("FFmpeg output is not a GIF file.");
      }

      return output;
    } finally {
      await Promise.allSettled([
        this.#ffmpeg.deleteFile(inputPath),
        this.#ffmpeg.deleteFile(outputPath),
      ]);
    }
  }

  async #ensureLoaded() {
    if (!this.#loadPromise) {
      this.#loadPromise = this.#ffmpeg.load({
        classWorkerURL: new URL("../vendor/ffmpeg/worker.js", import.meta.url)
          .href,
        coreURL: new URL(
          "../vendor/ffmpeg-core/ffmpeg-core.js",
          import.meta.url,
        ).href,
        wasmURL: new URL(
          "../vendor/ffmpeg-core/ffmpeg-core.wasm",
          import.meta.url,
        ).href,
      });
    }

    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = undefined;
      throw error;
    }
  }
}
