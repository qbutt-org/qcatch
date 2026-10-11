export type YoutubeFormat = "mp4" | "mp3";

export type YoutubeInfo = {
  id: string;
  url: string;
  title: string;
  duration: number;
  thumbnail?: string;
  channel?: string;
};

export type YoutubeInfoState = {
  status: "loading" | "ready" | "failed";
  info?: YoutubeInfo;
  error?: string;
};

export type YoutubeSelection = {
  format: YoutubeFormat;
  start: number;
  end: number | null;
};

export type YoutubeMessage =
  | { type: "youtube:health" }
  | { type: "youtube:retry-tools" }
  | { type: "youtube:info"; url: string; retry?: boolean }
  | { type: "youtube:jobs" }
  | { type: "youtube:download"; url: string; selection: YoutubeSelection }
  | { type: "youtube:play"; tabId: number; url: string }
  | { type: "youtube:cancel"; jobId: string }
  | { type: "youtube:reveal"; jobId: string }
  | { type: "youtube:selection:get"; tabId: number; url: string }
  | {
      type: "youtube:selection:set";
      tabId: number;
      url: string;
      selection: YoutubeSelection;
    };

export function youtubeVideoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    let id: string | null | undefined;
    if (url.hostname === "youtu.be") id = url.pathname.split("/")[1];
    else if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
      ].includes(url.hostname)
    ) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else
        id = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id)
      ? `https://www.youtube.com/watch?v=${id}`
      : undefined;
  } catch {
    return undefined;
  }
}
