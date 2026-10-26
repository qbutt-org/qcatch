export const NATIVE_BRIDGE_URL = "http://127.0.0.1:47832";
export const NATIVE_BRIDGE_PROTOCOL = 1;

export type NativeHealth = {
  protocol: number;
  version: string;
  desktopPath: string;
  qplayInstalled: boolean;
  qbuttInstalled: boolean;
  update?: {
    state: "disabled" | "idle" | "checking" | "current" | "ready" | "error" | "installing";
    version?: string;
    error?: string;
  };
  tools: {
    status: "checking" | "ready" | "error";
    ytDlpVersion?: string;
    error?: string;
  };
};

export type NativeJob = {
  format: "mp4" | "mp3" | "original";
  start: number;
  end: number | null;
  service?: string;
  filenames?: string[];
  id: string;
  url: string;
  title: string;
  status:
    | "queued"
    | "preparing"
    | "downloading"
    | "processing"
    | "canceling"
    | "completed"
    | "failed"
    | "canceled";
  progress: number;
  filename?: string;
  error?: string;
};
