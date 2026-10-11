#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir work
python3 - <<'PY'
import json
import pathlib
import subprocess

root = pathlib.Path.cwd()
work = root / 'work'
lock = json.loads((root / 'sources.json').read_text())
for source in lock['sources']:
    output = work / 'sources' / source['name']
    output.mkdir(parents=True)
    subprocess.run(['tar', '-xzf', str(root / source['file']), '--strip-components=1', '-C', str(output)], check=True)

project = work / 'sources' / 'ffmpeg.wasm'
dockerfile = project / 'Dockerfile'
text = dockerfile.read_text()
repositories = {source['repository'] + '.git': source['name'] for source in lock['sources']}
lines = []
for line in text.splitlines():
    if line.startswith('ADD https://github.com/'):
        repository = line.split()[1].split('#')[0]
        line = 'COPY local-sources/' + repositories[repository] + '/ /src/'
    elif line.startswith('RUN git clone --recursive '):
        line = 'COPY local-sources/zimg/ /src/'
    lines.append(line)
dockerfile.write_text('\n'.join(lines) + '\n')
local_sources = project / 'local-sources'
local_sources.mkdir()
for source in lock['sources']:
    if source['name'] not in {'ffmpeg.wasm', 'SDL2', 'emscripten', 'emsdk'}:
        subprocess.run(['cp', '-a', str(work / 'sources' / source['name']), str(local_sources / source['name'])], check=True)
PY
cd work/sources/ffmpeg.wasm
make prd
