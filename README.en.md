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

Run **qcatch-setup.exe**. After installation, setup instructions open.

The extension currently requires manual installation because there is no published store listing:

1. Open `edge://extensions` in Microsoft Edge or `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** and click **Load unpacked**.
3. Select the extension folder shown in the instructions.

Once connected, pin the qcatch icon to the browser toolbar. If the source page was already open before installation, refresh it.

The release page also offers a portable version.

## Download video

Open a page with video and start playback. Click the qcatch icon to see detected streams and tracks. Choose a source and save the video. Keep the source tab open until the download finishes, since the temporary URL or website session may expire.

qcatch supports direct files, HLS and DASH, separate audio, and text subtitles. Compatible tracks are combined into MP4 or MKV without re-encoding the video.

See [stream detection and site notes](docs/SUPPORTED-SITES.md). DRM-protected video is not supported.

## Watch in qplay

The watch button sends the selected video to the installed [qplay](https://github.com/qbutt-org/qplay), an independent player built on mpv. Install qplay first if it is not already installed.

When [qbutt](https://github.com/qbutt-org/qbutt) is installed, the same extension connects to it to provide the browser session and obtain the selected player's stream. qbutt offers to install qcatch from its interface.

## Data and permissions

The extension needs access to pages and network requests because video players and CDNs often use different domains. Detected URLs, the queue, and request parameters are processed locally. Video downloads come directly from the source website.

Do not include temporary URLs or authentication data in public bug reports. See the [security policy](SECURITY.md).

## Development

Bun is required; the Windows helper also requires Rust and Visual Studio Build Tools with the Windows SDK.

```powershell
bun install --frozen-lockfile
bun run check
bun run bridge:build
bun run release:build -- v1.0.0
```

See the [architecture](docs/ARCHITECTURE.md) and [project rules](AGENTS.md).

## License

qcatch is distributed under [AGPL-3.0-or-later](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). qcatch source is available from the [v1.0.0 tag](https://github.com/qbutt-org/qcatch/tree/v1.0.0); exact dependency sources are available in a separate [technical archive](https://github.com/qbutt-org/qcatch/releases/download/v1.0.0-sources/qcatch-1.0.0-runtime-sources.zip).
