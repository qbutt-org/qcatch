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

### Windows

Запустите **qcatch-setup.exe**. После установки откроется инструкция.

Для переносимой версии распакуйте `qcatch-portable.zip`.

### Linux

Linux x64 собирается для Ubuntu 24.04 и новее с glibc 2.39+. Как собрать пакет, описано в разделе [Разработка](#разработка).

Распакуйте собранный `qcatch-linux-x64.zip` и выполните `./qcatch --install` в его папке. Установка текущему пользователю регистрирует native host и запускает помощник. Для подключения Chrome или Chromium выполните `~/.local/bin/qcatch --connect-browser chrome`; для Edge замените `chrome` на `edge`.

Команда откроет страницу расширений и вернёт `extensionDirectory` — путь к установленной копии расширения. Используйте этот путь, а не папку из распакованного ZIP. Для обновления повторите `./qcatch --install` из нового пакета. Удаление через `~/.local/bin/qcatch --uninstall` сохраняет очередь и скачанные файлы.

### Подключение расширения

Расширение пока устанавливается вручную, поскольку опубликованной страницы в магазине нет:

1. Откройте `edge://extensions` в Microsoft Edge или `chrome://extensions` в Google Chrome либо Chromium.
2. Включите **Режим разработчика** и нажмите **Загрузить распакованное**.
3. Выберите папку расширения, указанную в инструкции.

После подключения закрепите значок qcatch на панели браузера. Если исходная страница была открыта до установки, обновите её.

В Windows установленная версия обновляется в фоне, когда завершены текущие действия и закрыто окно расширения. Расширение из установленной папки перезагружается автоматически. Portable-версия обновляется вручную.

## Скачать видео

Откройте страницу с видео и запустите воспроизведение. Нажмите значок qcatch: в списке появятся обнаруженные потоки и дорожки. Выберите источник и сохраните видео. Исходную вкладку лучше держать открытой до завершения, поскольку временная ссылка или сессия сайта могут истечь.

qcatch поддерживает прямые файлы, HLS и DASH, отдельный звук и текстовые субтитры. Совместимые дорожки объединяются в MP4 или MKV без перекодирования видео.

Ограничения описаны в [примечаниях к сайтам](docs/SUPPORTED-SITES.md). Защищённое DRM-видео не поддерживается.

## Смотреть в qplay

Кнопка «Открыть в qplay» передаёт выбранное видео в установленный [qplay](https://github.com/qbutt-org/qplay). Если плеера нет, qcatch предложит его скачать.

С установленным [qbutt](https://github.com/qbutt-org/qbutt) доступны «Смотреть в qbutt» и «Скачать через qbutt». Они передают выбранное медиа и браузерную сессию; обычная кнопка «Скачать видео» загружает файл через qcatch. Если qbutt нет, qcatch предлагает его скачать. qbutt также предлагает установить qcatch из своего интерфейса.

## Данные и разрешения

Расширению нужен доступ к страницам и сетевым запросам, поскольку видеоплеер и CDN часто находятся на разных доменах. Найденные ссылки, очередь и параметры запросов обрабатываются локально. Видео загружается напрямую с исходного сайта.

Временные ссылки и данные авторизации не следует включать в публичные отчёты об ошибках. См. [политику безопасности](SECURITY.md).

## Разработка

Нужны Bun и Rust. В Windows также требуются Visual Studio Build Tools с Windows SDK; в Linux — системный C/C++ toolchain.

```powershell
bun install --frozen-lockfile
bun run check
bun run bridge:build
```

`scripts/release.ts` собирает Windows-установщик и portable ZIP, `scripts/release-linux.ts` — `qcatch-linux-x64.zip`. Linux-пакетирование использует проверенные инструменты qplay из `QCATCH_LINUX_TOOLS`, включая `sources.json`. Тег, переданный скрипту выпуска, должен совпадать с версией в `package.json`.

См. [архитектуру](docs/ARCHITECTURE.md) и [правила проекта](AGENTS.md).

## Лицензия

qcatch распространяется по [AGPL-3.0-or-later](LICENSE). Лицензии сторонних компонентов приведены в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Исходники qcatch доступны в Git-теге соответствующего выпуска; точные исходники зависимостей — в отдельном техническом релизе по ссылке из описания выпуска.
