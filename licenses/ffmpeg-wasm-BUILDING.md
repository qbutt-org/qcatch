# ffmpeg.wasm corresponding source

qcatch redistributes the unmodified ESM `@ffmpeg/core` 0.12.10 WebAssembly binary, SHA-256 `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`, and `@ffmpeg/ffmpeg` 0.12.15 wrapper. The corresponding upstream source is ffmpeg.wasm commit `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` (tag `v12.15`). The similarly named older tag `v0.12.10` contains a different core version.

The sibling source archives contain that source tree and every library selected by its Dockerfile: FFmpeg n5.1.4, x264, x265, libvpx, LAME, Ogg, Theora, Opus, Vorbis, zlib, libwebp, FreeType, FriBidi, HarfBuzz, libass and zimg. SDL2 2.24.2 and Emscripten/emsdk 3.1.40 sources are included too. Each archive has an immutable revision and SHA-256 in `sources.json`. The original build scripts, configure options, source modifications and copyright notices are retained in the archives.

On Linux with Bash, GNU tar, Python 3, GNU Make, Docker and Buildx installed, run:

```sh
bash rebuild.sh
```

The script expands the archived source trees, replaces upstream Git downloads with those local trees, and runs upstream `make prd` (`FFMPEG_ST=yes`, `-O3 -msimd128`). Output is in `work/sources/ffmpeg.wasm/packages/core/dist/esm`. Docker downloads the upstream Emscripten 3.1.40 compiler image and distribution build tools; Emscripten fetches its SDL2 port using the upstream SHA-512 check. These build tools are not qcatch runtime components.

The original upstream Dockerfile used mutable names for x264 `4-cores` and LAME `master`; the source lock resolves their commits at the release date. Both predate the release. This recipe preserves the upstream configuration and supplies its corresponding source; a bit-for-bit rebuild of the npm publisher's environment has not been verified. qcatch does not modify the distributed wasm binary.
