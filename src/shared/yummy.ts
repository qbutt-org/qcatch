import type { YummySource } from "./types.ts";

export function sameYummySource(left: YummySource, right: YummySource): boolean {
  return left.kind === right.kind && left.name === right.name;
}

export function yummySourceKey(source: YummySource): string {
  return `${source.kind}\u0000${source.name}`;
}
