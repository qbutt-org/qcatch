import { parseRutubeVideoUrl } from "./rutube.ts";
import { isTwitterPostUrl } from "./twitter-page.ts";
import { parseVkVideoUrl } from "./vk.ts";
import { platformReference, type Platform } from "./platforms.ts";

export function oneClickService(value: string | undefined): "rutube" | "twitter" | "vk" | Platform | undefined {
  if (parseRutubeVideoUrl(value)) return "rutube";
  if (isTwitterPostUrl(value)) return "twitter";
  if (parseVkVideoUrl(value)) return "vk";
  return platformReference(value)?.service;
}
