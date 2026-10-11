import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await Promise.all([
  rm(resolve("artifacts"), { force: true, recursive: true }),
  rm(resolve("dist"), { force: true, recursive: true }),
]);
