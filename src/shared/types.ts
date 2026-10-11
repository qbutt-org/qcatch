import type { TwitterCapture } from "./twitter-media.ts";
import type { YoutubeMessage } from "./youtube.ts";

export type MediaKind =
  | "audio"
  | "dash"
  | "hls"
  | "segment"
  | "subtitle"
  | "video"
  | "unknown";

export type Provider = "alloha" | "cdnvideohub" | "kodik" | "unknown";

export type CapturedHeader = {
  name: string;
  value: string;
};

export type YummyProbe = {
  episode: number;
  sourceId: string;
};

export type CapturePayload = {
  body?: string;
  contentType?: string;
  default?: boolean;
  detectedAt: number;
  episode?: number;
  forced?: boolean;
  headers?: CapturedHeader[];
  initiator?: string;
  kind: MediaKind;
  language?: string;
  method?: string;
  name?: string;
  probe?: YummyProbe;
  provider: Provider;
  referer?: string;
  requestUrl?: string;
  status?: number;
  url: string;
};

export type CapturedResource = CapturePayload & {
  frameId: number;
  id: string;
  tabId: number;
};

export type EpisodeSelection = {
  available: number[];
};

export type YummySourceKind = "audio" | "subtitle";

export type YummySource = {
  kind: YummySourceKind;
  name: string;
};

export type YummyProbeSource = YummySource & {
  episodes?: number[];
  iframeUrl: string;
  probeId: string;
};

export type YummyContext = {
  episode: number;
  episodes: EpisodeSelection;
  iframeUrl: string;
  player: string;
  playerOptions: string[];
  source: YummySource;
  sources: YummySource[];
  title: string;
};

export type YummyCatalog = {
  context: YummyContext;
  sources: YummyProbeSource[];
};

export type YummyEstimate = {
  tracks: Array<{
    bytes?: number;
    key: string;
  }>;
};

export type PageContext = {
  title: string;
  url: string;
  yummy?: YummyContext;
};

export type TabState = {
  page: PageContext;
  resources: CapturedResource[];
  revision: number;
  tabId: number;
  twitter?: TwitterCapture;
};

export type Container = "mkv" | "mp4";

export type MediaDownload = {
  filename: string;
  type: "gif" | "photo" | "video";
  url: string;
  convertToGif?: boolean;
};

export type DownloadInput = {
  headers: CapturedHeader[];
  kind: Exclude<MediaKind, "segment" | "subtitle" | "unknown">;
  name?: string;
  role: "audio" | "media";
  url: string;
};

export type DownloadSubtitle = {
  default: boolean;
  forced: boolean;
  headers: CapturedHeader[];
  language: string;
  name: string;
  url: string;
};

export type DownloadJob = {
  container: Container;
  createdAt: number;
  episode?: number;
  expectedDuration?: number;
  filename: string;
  id: string;
  inputs: DownloadInput[];
  pageUrl: string;
  player?: string;
  subtitles: DownloadSubtitle[];
  tabId: number;
  title: string;
  yummySources?: YummySource[];
};

export type PopupPreferences = {
  audioIds: string[];
  audioSelectionTouched?: boolean;
  container: Container;
  pageUrl: string;
  sourceId: string;
  subtitleIds: string[];
  subtitleSelectionTouched?: boolean;
  yummy?: {
    episodes: number[];
    episodesTouched?: boolean;
    player: string;
    sourceKeys?: string[];
    sourcesTouched?: boolean;
  };
};

export type YummyBatchRequest = {
  container: Container;
  context: YummyContext;
  episodes: number[];
  pageUrl: string;
  selectedSources: YummySource[];
  tabId: number;
};

export type PreparedYummyBatchRequest = YummyBatchRequest & {
  sources: YummyProbeSource[];
};

export type YummyBatchResult = {
  jobs: DownloadJob[];
  queue: QueueSnapshot;
};

export type QueueStatus =
  | "canceled"
  | "completed"
  | "downloading"
  | "failed"
  | "preparing"
  | "queued"
  | "saving";

export type QueueItem = {
  error?: string;
  job: DownloadJob;
  progress: number;
  status: QueueStatus;
};

export type QueueSnapshot = {
  items: QueueItem[];
  revision: number;
};

export type BridgeCaptureMessage = {
  payload: CapturePayload;
  type: "bridge:capture";
};

export type BridgePageMessage = {
  page: PageContext;
  type: "bridge:page";
};

export type BridgeTwitterMessage = {
  capture: TwitterCapture;
  type: "bridge:twitter";
};

export type BackgroundMessage =
  | YoutubeMessage
  | BridgeCaptureMessage
  | BridgePageMessage
  | BridgeTwitterMessage
  | { tabId: number; type: "state:get" }
  | { pageUrl: string; tabId: number; type: "preferences:get" }
  | { preferences: PopupPreferences; tabId: number; type: "preferences:set" }
  | { type: "queue:get" }
  | { jobs: DownloadJob[]; type: "queue:add" }
  | { jobId: string; type: "queue:cancel" }
  | { tabId: number; type: "yummy:options" }
  | { player: string; tabId: number; type: "yummy:catalog" }
  | { error?: string; jobId: string; progress: number; status: QueueStatus; type: "queue:update" }
  | { job: DownloadJob; type: "engine:prepare" }
  | { type: "engine:release" }
  | { filename: string; type: "download:save"; url: string }
  | { request: YummyBatchRequest; type: "yummy:batch" }
  | { request: YummyBatchRequest; type: "yummy:estimate" }
  | { job: DownloadJob; request: PreparedYummyBatchRequest; type: "yummy:prepare-one" };

export type OffscreenMessage =
  | { job: DownloadJob; target: "offscreen"; type: "offscreen:run" }
  | { jobId: string; target: "offscreen"; type: "offscreen:cancel" }
  | { jobs: DownloadJob[]; request: PreparedYummyBatchRequest; target: "offscreen"; type: "offscreen:yummy-batch" };

export const EMPTY_QUEUE: QueueSnapshot = { items: [], revision: 0 };

export function emptyTabState(tabId: number): TabState {
  return {
    page: { title: "Текущая страница", url: "" },
    resources: [],
    revision: 0,
    tabId,
  };
}
