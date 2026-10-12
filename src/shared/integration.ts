import { youtubeVideoUrl } from "./youtube.ts";

export type ProductActionKind = "play" | "watch" | "download";

export interface ProductSelection {
  tabId: number;
  pageUrl: string;
  sourceId?: string;
  audioIds: string[];
  subtitleIds: string[];
}

export interface ProductAction {
  id: string;
  key: string;
  action: ProductActionKind;
  previousId?: string;
  status: "preparing" | "sending" | "sent" | "failed" | "uncertain";
  error?: string;
}

export type IntegrationMessage =
  | { type: "integration:health" }
  | { type: "integration:state"; tabId: number }
  | (ProductSelection & { type: "media:play"; previousId?: string })
  | (ProductSelection & {
      type: "integration:handoff";
      action: "watch" | "download";
      previousId?: string;
    });

export function productActionKey(
  action: ProductActionKind,
  selection: ProductSelection,
): string {
  return JSON.stringify([
    action,
    youtubeVideoUrl(selection.pageUrl) ?? selection.pageUrl.replace(/#.*$/, ""),
    selection.sourceId ?? "",
    [...new Set(selection.audioIds)].sort(),
    [...new Set(selection.subtitleIds)].sort(),
  ]);
}
