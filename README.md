<p align="center">
  <strong>Русский</strong> / <a href="README.en.md">English</a>
</p>

<h1 align="center">qcatch</h1>

<p align="center">
  Расширение для скачивания видео.
</p>

<p align="center">
  <a href="https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-setup.exe">
    <img alt="Скачать qcatch для Windows" src="https://img.shields.io/badge/%D0%A1%D0%9A%D0%90%D0%A7%D0%90%D0%A2%D0%AC-Windows-009df7?style=for-the-badge">
  </a>
  <a href="https://github.com/qbutt-org/qcatch/releases">
    <img alt="Все релизы" src="https://img.shields.io/badge/%D0%A0%D0%95%D0%9B%D0%98%D0%97%D0%AB-%D0%B2%D1%81%D0%B5_%D0%B2%D0%B5%D1%80%D1%81%D0%B8%D0%B8-24292f?style=for-the-badge&amp;logo=github&amp;logoColor=white">
  </a>
</p>

<p align="center">
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078d4?style=flat-square">
  <a href="https://github.com/qbutt-org/qcatch/releases/latest">
    <img alt="Последний релиз" src="https://img.shields.io/github/v/release/qbutt-org/qcatch?label=release&amp;color=009df7&amp;style=flat-square">
  </a>
  <a href="LICENSE">
    <img alt="AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square">
  </a>
</p>

<p align="center">
  <a href="https://qbutt-org.github.io/qcatch/">Сайт</a> /
  <a href="https://github.com/qbutt-org/qcatch/releases/latest/download/qcatch-portable.zip">Portable</a>
</p>

## Установка

Запустите **qcatch-setup.exe**. После установки откроется инструкция.

Расширение пока устанавливается вручную, поскольку опубликованной страницы в магазине нет:

1. Откройте `edge://extensions` в Microsoft Edge или `chrome://extensions` в Google Chrome.
2. Включите **Режим разработчика** и нажмите **Загрузить распакованное**.
3. Выберите папку расширения, указанную в инструкции.

После подключения закрепите значок qcatch на панели браузера. Если исходная страница была открыта до установки, обновите её.

На странице релиза доступна также portable-версия.

## Скачать видео

Откройте страницу с видео и запустите воспроизведение. Нажмите значок qcatch: в списке появятся обнаруженные потоки и дорожки. Выберите источник и сохраните видео. Исходную вкладку лучше держать открытой до завершения, поскольку временная ссылка или сессия сайта могут истечь.

qcatch поддерживает прямые файлы, HLS и DASH, отдельный звук и текстовые субтитры. Совместимые дорожки объединяются в MP4 или MKV без перекодирования видео.

Ограничения описаны в [примечаниях к сайтам](docs/SUPPORTED-SITES.md). Защищённое DRM-видео не поддерживается.

## Смотреть в qplay

Кнопка «Открыть в qplay» передаёт выбранное видео в установленный [qplay](https://github.com/qbutt-org/qplay). Если плеера нет, qcatch предложит его установить.

С установленным [qbutt](https://github.com/qbutt-org/qbutt) доступны «Смотреть в qbutt» и «Скачать через qbutt». Они передают выбранное медиа и браузерную сессию; обычная кнопка «Скачать видео» загружает файл через qcatch. Если qbutt нет, qcatch предлагает перейти на его сайт для установки. qbutt также предлагает установить qcatch из своего интерфейса.

## Данные и разрешения

Расширению нужен доступ к страницам и сетевым запросам, поскольку видеоплеер и CDN часто находятся на разных доменах. Найденные ссылки, очередь и параметры запросов обрабатываются локально. Видео загружается напрямую с исходного сайта.

Временные ссылки и данные авторизации не следует включать в публичные отчёты об ошибках. См. [политику безопасности](SECURITY.md).

## Разработка

Нужны Bun, а для Windows-помощника — Rust и Visual Studio Build Tools с Windows SDK.

```powershell
bun install --frozen-lockfile
bun run check
bun run bridge:build
bun run release:build -- v1.1.0
```

См. [архитектуру](docs/ARCHITECTURE.md) и [правила проекта](AGENTS.md).

## Лицензия

qcatch распространяется по [AGPL-3.0-or-later](LICENSE). Лицензии сторонних компонентов приведены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Исходники qcatch доступны в [теге v1.1.0](https://github.com/qbutt-org/qcatch/tree/v1.1.0); точные исходники зависимостей — в отдельном [техническом архиве](https://github.com/qbutt-org/qcatch/releases/download/v1.1.0-sources/qcatch-1.1.0-runtime-sources.zip).
