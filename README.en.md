<p align="center">
  <a href="README.md">Русский</a> / <strong>English</strong>
</p>

<h1 align="center">qcatch</h1>

<p align="center">
  A browser extension for downloading videos.
</p>

<p align="center">
  <a href="https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe">
    <img alt="Download qcatch for Windows" src="https://img.shields.io/badge/DOWNLOAD-Windows-009df7?style=for-the-badge">
  </a>
  <a href="https://github.com/qbutt-org/qcatch/releases">
    <img alt="All releases" src="https://img.shields.io/badge/RELEASES-all_versions-24292f?style=for-the-badge&amp;logo=github&amp;logoColor=white">
  </a>
</p>

<p align="center">
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square">
  <a href="https://github.com/qbutt-org/qcatch/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/qbutt-org/qcatch?label=release&amp;color=009df7&amp;style=flat-square">
  </a>
  <a href="LICENSE">
    <img alt="AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square">
  </a>
</p>

<p align="center">
  <a href="https://qbutt-org.github.io/qcatch/en/">Website</a> /
  <a href="https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-portable.zip">Portable</a>
</p>

## Installation

### Windows

Run **qcatch-setup.exe**. After installation, setup instructions open.

For the portable version, extract `qcatch-portable.zip`.

### Linux

Linux x64 requires Ubuntu 24.04 or later with glibc 2.39+. Download [qcatch-linux-x64.zip](https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-linux-x64.zip) and extract the archive.

Run `./qcatch --install` in the extracted directory. Per-user installation registers the native host and starts the helper. To connect Chrome or Chromium, run `~/.local/bin/qcatch --connect-browser chrome`; for Edge, replace `chrome` with `edge`.

The command opens the extensions page and returns `extensionDirectory`, the path to the installed extension. Use that path instead of the extracted ZIP directory. To update, run `./qcatch --install` from the new bundle. `~/.local/bin/qcatch --uninstall` preserves the queue and downloaded files.

### Connect the extension

The extension currently requires manual installation because there is no published store listing:

1. Open `edge://extensions` in Microsoft Edge or `chrome://extensions` in Google Chrome or Chromium.
2. Enable **Developer mode** and click **Load unpacked**.
3. Select the extension folder shown in the instructions.

Once connected, pin the qcatch icon to the browser toolbar. If the source page was already open before installation, refresh it.

On Windows, the installed version updates in the background when current actions finish and the extension popup is closed. The extension reloads automatically when loaded from the installed folder. The portable version is updated manually.

## Download video

Open a page with video and start playback. Click the qcatch icon to see detected streams and tracks. Choose a source and save the video. Keep the source tab open until the download finishes, since the temporary URL or website session may expire.

qcatch supports direct files, HLS and DASH, separate audio, and text subtitles. Compatible tracks are combined into MP4 or MKV without re-encoding the video.

See [stream detection and site notes](docs/SUPPORTED-SITES.md). DRM-protected video is not supported.

## Watch in qplay

Open in qplay sends the selected video to the installed [qplay](https://github.com/qbutt-org/qplay). If the player is missing, qcatch offers to download it.

With [qbutt](https://github.com/qbutt-org/qbutt) installed, Watch in qbutt and Download with qbutt are available. They send the selected media and browser session; the regular Download video button saves through qcatch. If qbutt is missing, qcatch offers its download. qbutt also offers to install qcatch from its interface.

## Data and permissions

The extension needs access to pages and network requests because video players and CDNs often use different domains. Detected URLs, the queue, and request parameters are processed locally. Video downloads come directly from the source website.

Do not include temporary URLs or authentication data in public bug reports. See the [security policy](SECURITY.md).

## Development

Bun and Rust are required. Windows also needs Visual Studio Build Tools with the Windows SDK; Linux needs the system C/C++ toolchain.

```powershell
bun install --frozen-lockfile
bun run check
bun run bridge:build
```

`scripts/release.ts` builds the Windows installer and portable ZIP; `scripts/release-linux.ts` builds `qcatch-linux-x64.zip`. Linux packaging uses verified qplay tools from `QCATCH_LINUX_TOOLS`, including `sources.json`. The release script requires a tag matching the version in `package.json`.

See the [architecture](docs/ARCHITECTURE.md) and [project rules](AGENTS.md).

## License

qcatch is distributed under [AGPL-3.0-or-later](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). qcatch source is available from the corresponding release tag; exact dependency sources are provided in a separate technical release linked from the product release description.
