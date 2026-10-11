import type { TwitterMedia } from "../shared/twitter-media.ts";
import type { MediaDownload } from "../shared/types.ts";

export class TwitterMediaError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function parseTweetUrl(value: string): { id: string; index?: number };
export function fetchTwitterMedia(rawUrl: string, fetchImplementation?: typeof fetch): Promise<MediaDownload[]>;
export function twitterMediaToDownloads(rawUrl: string, media: TwitterMedia[]): MediaDownload[];
