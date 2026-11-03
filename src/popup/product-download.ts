import type { Language } from "../shared/localization.ts";

export async function downloadProduct(
  product: "qplay" | "qcatch" | "qbutt",
  language: Language,
): Promise<void> {
  const { os, arch } = await chrome.runtime.getPlatformInfo();
  const releases = `https://github.com/qbutt-org/${product}/releases/latest`;
  let url = releases;

  if (arch === "x86-64" && (os === "win" || os === "linux")) {
    if (product === "qbutt") {
      url = `https://qbutt-org.github.io/qbutt/${language === "en" ? "en/" : ""}?lang=${language}`;
    } else {
      const asset = os === "win" ? `${product}-setup.exe` : `${product}-linux-x64.zip`;
      url = `${releases}/download/${asset}`;
    }
  }

  await chrome.tabs.create({ url });
}
