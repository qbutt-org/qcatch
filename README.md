**Русский** / [English](README.en.md)

# qcatch

[![Windows x64](https://img.shields.io/badge/Windows-x64-0078d4)](https://qbutt-org.github.io/qcatch/)
[![Последний релиз](https://img.shields.io/github/v/release/qbutt-org/qcatch?label=release&color=009df7)](https://github.com/qbutt-org/qcatch/releases/latest)
[![AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

qcatch — расширение для скачивания видео.

[![Скачать для Windows](docs/assets/download.svg)](https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe)

[Сайт](https://qbutt-org.github.io/qcatch/) / [Все файлы](https://github.com/qbutt-org/qcatch/releases/latest) / [Что нового](https://github.com/qbutt-org/qcatch/releases)

## Установка

Запустите **qcatch-setup.exe**. Установщик подготовит помощник Windows и папку расширения.

Расширение пока устанавливается вручную, поскольку опубликованной страницы в магазине нет:

1. Откройте `edge://extensions` в Microsoft Edge или `chrome://extensions` в Google Chrome.
2. Включите **Режим разработчика** и нажмите **Загрузить распакованное**.
3. Выберите папку расширения, которую открыл установщик.

После подключения закрепите значок qcatch на панели браузера. Если исходная страница была открыта до установки, обновите её.

На странице релиза доступна также portable-версия.

## Скачать видео

Откройте страницу с видео и запустите воспроизведение. Нажмите значок qcatch: в списке появятся обнаруженные потоки и дорожки. Выберите источник и сохраните видео. Исходную вкладку лучше держать открытой до завершения, поскольку временная ссылка или сессия сайта могут истечь.

qcatch поддерживает прямые файлы, HLS и DASH, отдельный звук и текстовые субтитры. Совместимые дорожки объединяются в MP4 или MKV без перекодирования видео. Для YummyAnime доступен выбор серий и пакетная загрузка.

YouTube и YouTube Music используют комплектный помощник Windows: можно сохранить видео в MP4, звук в MP3 или выбранный отрезок. Готовые файлы помощник сохраняет на Рабочий стол.

Подробности и ограничения находятся в [списке поддерживаемых сайтов](docs/SUPPORTED-SITES.md). Защищённое DRM-видео не поддерживается.

## Смотреть в qplay

Кнопка просмотра передаёт выбранное видео в установленный [qplay](https://github.com/qbutt-org/qplay), самостоятельный плеер на основе mpv. Сначала установите qplay, если его ещё нет.

При наличии [qbutt](https://github.com/qbutt-org/qbutt) то же расширение подключается к нему для браузерной сессии и получения потока выбранного плеера. qbutt предлагает установить qcatch из своего интерфейса.

## Данные и разрешения

Расширению нужен доступ к страницам и сетевым запросам, поскольку видеоплеер и CDN часто находятся на разных доменах. Найденные ссылки, очередь и параметры запросов обрабатываются локально. Видео загружается напрямую с исходного сайта.

Временные ссылки и данные авторизации не следует включать в публичные отчёты об ошибках. См. [политику безопасности](SECURITY.md).

## Разработка

Нужны Bun, а для Windows-помощника — Rust и Visual Studio Build Tools с Windows SDK.

```powershell
bun install --frozen-lockfile
bun run check
bun run bridge:build
bun run release:build -- v1.0.0
```

См. [архитектуру](docs/ARCHITECTURE.md) и [правила проекта](AGENTS.md).

## Лицензия

qcatch распространяется по [AGPL-3.0-or-later](LICENSE). Лицензии сторонних компонентов приведены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Исходники qcatch доступны в [теге v1.0.0](https://github.com/qbutt-org/qcatch/tree/v1.0.0); точные исходники зависимостей — в отдельном [техническом архиве](https://github.com/qbutt-org/qcatch/releases/download/v1.0.0-sources/qcatch-1.0.0-runtime-sources.zip).
