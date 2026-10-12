export type Language = "ru" | "en";

const english = {
  "Открыть эфир в qplay": "Watch live in qplay",
  "Эфир открыт в qplay": "Live stream opened in qplay",
  "Скачать трек": "Download track",
  "Скачать медиа": "Download media",
  "Откройте страницу источника и повторите.": "Open the source page and retry.",
  "Откройте отдельный пост, клип или трек и повторите.":
    "Open one supported post, clip or track and retry.",
  "Страница изменилась. Откройте медиа снова и повторите.":
    "The page changed. Open the media again and retry.",
  "Войдите на сайт источника, откройте медиа и повторите.":
    "Sign in to the source site, open the media and retry.",
  "Источник вернул другое медиа. Обновите пост и повторите.":
    "The source returned different media. Reload the post and retry.",
  "Источник не вернул это медиа. Откройте его в плеере сайта и повторите.":
    "The source did not return this media. Open it in the site's player and retry.",
  "Откройте полную ссылку на пин Pinterest и повторите.":
    "Open the full Pinterest pin link and retry.",
  "В этом пине нет доступного медиа. Откройте оригинальный источник.":
    "This pin has no downloadable media. Open the original source instead.",
  "Пин ссылается на видео другого сайта. Откройте оригинальный источник и скачайте видео там.":
    "This pin links to another site's video. Open its original source and download it there.",
  "Обновите этот фотопост TikTok и повторите.":
    "Reload this TikTok photo post and retry.",
  "Источник не вернул это изображение. Обновите пост и повторите.":
    "The source did not return this image. Reload the post and retry.",
  "Откройте и запустите именно этот трек VK Музыки, затем повторите. На странице нет ссылки на полную аудиодорожку.":
    "Open and play this exact VK Music track, then retry. Its full audio link is not available on this page.",
  "В посте нет доступного медиа или слишком много элементов. Откройте один пост и повторите.":
    "The post has no downloadable media or too many items. Open one post and retry.",
  "Не удалось прочитать медиа. Обновите страницу источника и повторите.":
    "Could not read this media. Reload the source page and retry.",
  "Страница источника не отвечает. Обновите её и повторите.":
    "The source page did not respond. Reload it and retry.",
  "Откройте этот трек из его альбома в Яндекс Музыке и повторите.":
    "Open this track from its Yandex Music album, then retry.",
  "Установите qplay и повторите открытие.":
    "qplay is not installed. Install qplay and try again.",
  "Расширение не отвечает. Обновите qcatch на странице расширений браузера и повторите.":
    "The extension did not respond. Reload qcatch in your browser's extensions page and retry.",
  "Дождитесь подготовки инструментов и повторите.":
    "Wait for the tools to finish preparing, then retry.",
  "Для прямого эфира Twitch используйте просмотр. Скачать можно клипы.":
    "Use Watch for a Twitch live stream. Download is available for clips.",
  "Очередь загрузок заполнена. Дождитесь завершения загрузки.":
    "The download queue is full. Wait for a download to finish.",
  "Не удалось сохранить очередь загрузок.":
    "Could not save the download queue.",
  "Источник не вернул медиа. Откройте и запустите пост на сайте, затем повторите.":
    "The source returned no media. Open and play the post on its site, then retry.",
  "Нельзя скачать медиа с защитой DRM.":
    "DRM-protected media cannot be downloaded.",
  "Источник не вернул полную длительность медиа.":
    "The source did not return the full media duration.",
  "Источник не вернул звук поста. Откройте и запустите пост, затем повторите.":
    "The source did not return the post's audio. Open and play the post, then retry.",
  "Источник вернул только резервное видео без остальных дорожек. Откройте и запустите пост, затем повторите.":
    "The source returned only a fallback video without its other tracks. Open and play the post, then retry.",
  "В скачанном файле отсутствует видеодорожка.":
    "The downloaded video track is missing.",
  "Скачанное видео не соответствует выбранному максимальному разрешению.":
    "The downloaded video does not match the selected maximum resolution.",
  "В скачанном файле отсутствует аудиодорожка.":
    "The downloaded audio track is missing.",
  "В скачанном файле отсутствуют дорожки субтитров.":
    "The downloaded subtitle tracks are missing.",
  "Полный формат недоступен. Войдите на сайт источника и повторите. Превью нельзя сохранить как полный трек.":
    "No full media format is available. Sign in to the source and retry; previews cannot be saved as full tracks.",
  "Файл неполный или содержит превью. Откройте полный трек в плеере источника и повторите.":
    "The file is incomplete or contains a preview. Open the full track in the source player and retry.",
  "Источник запросил проверку на бота. Откройте медиа в Edge и повторите. Если не поможет, попробуйте позже или проверьте сеть и VPN.":
    "The source requested a bot check. Open the media in Edge and retry; if it persists, try later or check your network/VPN.",
  "Источник требует входа или подтверждения возраста. Пройдите проверку в Edge, откройте медиа и повторите.":
    "The source requires sign-in or age verification. Complete it in Edge, open the media and retry.",
  "Источник отклонил медиассылку (403). Откройте медиа в плеере и повторите. Проверьте сеть и VPN.":
    "The source rejected the media link (403). Open the media in its player and retry; check your network/VPN.",
  "Не удалось подключиться к источнику. Проверьте интернет и VPN, затем повторите.":
    "Could not connect to the source. Check your internet connection and VPN, then retry.",
  Источник: "Source",
  "Текущая страница": "Current page",
  Аудиодорожки: "Audio tracks",
  Субтитры: "Subtitles",
  Плеер: "Player",
  Озвучки: "Audio tracks",
  Серии: "Episodes",
  Все: "All",
  Снять: "Clear",
  "Все {count}": "All {count}",
  "{selected} из {total}": "{selected} of {total}",
  "Считаем…": "Estimating…",
  "Считаем размер…": "Estimating size…",
  Загрузки: "Downloads",
  Отменить: "Cancel",
  Отменено: "Canceled",
  Готово: "Complete",
  Скачивание: "Downloading",
  "Не удалось скачать": "Download failed",
  "Ищем поток": "Finding media",
  "В очереди": "Queued",
  "Сохраняем файл": "Saving file",
  "Подготовка…": "Preparing…",
  "Обработка файла…": "Processing file…",
  "Серия {episode}": "Episode {episode}",
  "{count} в работе": "{count} active",
  "{count} в списке": "{count} listed",
  "Собираем дорожки…": "Preparing tracks…",
  "Добавляем…": "Adding…",
  "Скачать видео": "Download video",
  "Скачать аудио": "Download audio",
  "Скачать {episodes}": "Download {episodes}",
  "Смотрим страницу": "Checking the page",
  "Запустите видео": "Play a video",
  "После начала воспроизведения здесь появятся качество, звук и субтитры.":
    "Available video, audio and subtitles will appear here.",
  "Страница недоступна": "Page unavailable",
  "Открываем страницу": "Opening page",
  "Выберите хотя бы одну серию": "Select at least one episode.",
  "Выберите хотя бы одну озвучку или субтитры":
    "Select at least one audio or subtitle track.",
  "Страница аниме изменилась. Откройте popup заново.":
    "The anime page changed. Reopen qcatch.",
  "Открыть в qplay": "Open in qplay",
  "Установить qplay": "Install qplay",
  "Установить qbutt": "Install qbutt",
  "Установить qcatch для Windows": "Install qcatch for Windows",
  "Смотреть в qbutt": "Watch in qbutt",
  "Скачать через qbutt": "Download with qbutt",
  "Открываем qplay…": "Opening qplay…",
  "Передаём в qbutt…": "Sending to qbutt…",
  "Снова открыть в qplay": "Open in qplay again",
  "Снова смотреть в qbutt": "Watch in qbutt again",
  "Снова скачать через qbutt": "Download with qbutt again",
  "Проверить подключение": "Check connection",
  "Серия {number}": "Episode {number}",
  "Плеер {number}": "Player {number}",
  "Передача прервана. Повторите попытку.": "Transfer interrupted. Retry.",
  "Ответ потерян. Проверьте окно приложения.": "Response lost. Check the application's window.",
  "Ответ приложения не удалось прочитать.": "Could not read the application's response.",
  "Дождитесь текущей передачи.": "Wait for the current transfer.",
  "Выбор передачи устарел. Откройте qcatch заново.": "The transfer selection expired. Reopen qcatch.",
  "Обновите страницу и снова выберите видео в qcatch.": "Reload the page and select the video in qcatch again.",
  "Выбранное видео изменилось или передача устарела. Откройте qcatch и передайте видео заново.": "This capture expired or changed. Open qcatch and send the media again.",
  "Нужно приложение на компьютере": "Install the Windows app",
  "Установите или запустите qcatch для Windows.":
    "Install or launch qcatch for Windows.",
  "Скачать приложение": "Download app",
  "Подробности подключения": "Connection details",
  "Не удалось подготовить загрузку": "Could not prepare the download",
  "Проверьте подключение к интернету и попробуйте снова.":
    "Check your internet connection and try again.",
  "Подготавливаем…": "Preparing…",
  "Попробовать снова": "Try again",
  "Готовим загрузку": "Preparing download",
  Подключаемся: "Connecting",
  "При первом запуске подготовка займёт немного времени.":
    "First launch may take a moment.",
  "Не удалось открыть трек": "Could not open the track",
  "Не удалось открыть видео": "Could not open the video",
  "Проверьте, что страница доступна, и попробуйте снова.":
    "Check that the page is available and try again.",
  "Открываем трек": "Opening track",
  "Открываем видео": "Opening video",
  "Трек целиком": "Whole track",
  "Видео целиком": "Whole video",
  Фрагмент: "Clip",
  Целиком: "Whole",
  "Начало фрагмента": "Clip start",
  "Конец фрагмента": "Clip end",
  Начало: "Start",
  Конец: "End",
  "{duration} к загрузке": "{duration} selected",
  "Видео / MP4": "Video / MP4",
  "Аудио / MP3": "Audio / MP3",
  "Уже в очереди": "Already queued",
  Скачать: "Download",
  Показать: "Show file",
  "до конца": "to end",
  "Укажите время в формате 00:00 или 0:00:00.":
    "Enter a time as 00:00 or 0:00:00.",
  "Начало должно быть раньше конца.": "Start must be earlier than end.",
  "Конец не может быть позже {duration}.": "End cannot exceed {duration}.",
  "Не удалось восстановить выбор. Проверьте формат и время перед скачиванием.":
    "Could not restore your selection. Check the format and time before downloading.",
  "Не удалось сохранить выбор. Оставьте это окно открытым до начала скачивания.":
    "Could not save your selection. Keep this window open until the download starts.",
  "Не удалось обновить список загрузок. Проверьте приложение qcatch на компьютере.":
    "Could not refresh downloads. Check the qcatch Windows app.",
  "Нет ответа от фоновой части расширения. Нажмите «Обновить» на карточке qcatch в списке расширений и откройте popup заново.":
    "The extension is not responding. Reload qcatch on the browser extensions page, then reopen it.",
  "Локальный помощник не отвечает. Установите или запустите qcatch и повторите попытку.":
    "qcatch for Windows is not responding. Install or launch it and try again.",
  "Откройте конкретное видео на YouTube.": "Open a specific YouTube video.",
  "Проверьте формат и границы отрезка: конец должен быть позже начала.":
    "Check the format and clip range: end must be later than start.",
  "Обновите qcatch: версия помощника несовместима с расширением.":
    "Update qcatch: the Windows app and extension versions are incompatible.",
  "Запустите видео или трек на странице, затем откройте его в qplay.":
    "Play the video or track on the page, then open it in qplay.",
  "Видео на странице изменилось. Откройте popup заново.":
    "The video changed. Reopen qcatch.",
  "Неизвестная загрузка.": "Unknown download.",
  "Откройте постоянную страницу видео без временной ссылки доступа.":
    "Open the permanent video page instead of a temporary access link.",
  "Страница изменилась. Откройте qcatch заново.":
    "The page changed. Reopen qcatch.",
  "Выберите источник видео.": "Select a video source.",
  "Источник устарел. Откройте qcatch заново.":
    "This source expired. Reopen qcatch.",
  "Слишком много недавних передач. Повторите через несколько минут.":
    "Too many recent transfers. Try again in a few minutes.",
  "Этот HLS-поток зашифрован и не поддерживается":
    "This HLS stream is encrypted and is not supported.",
  "HLS-плейлист содержит слишком много уровней вложенности":
    "This HLS playlist has too many nested levels.",
  "HLS-плейлист не содержит медиасегментов":
    "This HLS playlist contains no media segments.",
  "Загрузка отменена": "Download canceled.",
  "В выбранном источнике нет совместимых видео- или аудиодорожек":
    "This source has no compatible video or audio tracks.",
  "Не удалось подключиться к странице YummyAnime. Обновите вкладку и повторите попытку.":
    "Could not connect to YummyAnime. Reload the tab and try again.",
  "Не удалось определить основной поток серии":
    "Could not identify the episode's main stream.",
  "Исходная страница аниме изменилась. Вернитесь на неё и запустите загрузку заново.":
    "The anime page changed. Return to it and start the download again.",
  "Страница аниме изменилась. Откройте popup заново, чтобы обновить дорожки.":
    "The anime page changed. Reopen qcatch to refresh the tracks.",
  "Страница аниме изменилась. Откройте popup заново и повторите загрузку.":
    "The anime page changed. Reopen qcatch and try again.",
  "Сохранение файла разрешено только внутреннему обработчику":
    "File saving is only available to qcatch's download handler.",
  "Браузер не смог начать загрузку.":
    "The browser could not start the download.",
  "Не удалось выполнить действие. Откройте страницу и попробуйте снова.":
    "Could not complete this action. Open the page and try again.",
  Подробности: "Details",
  Язык: "Language",
  "Для этого источника нужны приватные заголовки запроса. Скачайте его через qcatch.":
    "This source requires private request headers. Download it through qcatch instead.",
  "Эти аудиодорожки или субтитры требуют отдельного входа. Скачайте их через qcatch.":
    "These audio or subtitle tracks require separate sign-in. Download them through qcatch instead.",
  "qbutt поддерживает одну внешнюю аудиодорожку. Выберите одну дорожку и попробуйте снова.":
    "qbutt currently supports one external audio track. Select one audio track and try again.",
  "Заголовки источников конфликтуют. Скачайте эти дорожки отдельно.":
    "Conflicting source request headers. Download these tracks separately.",
  "Слишком много медиаисточников.": "Too many media sources.",
  "qplay не установлен. Установите qplay и попробуйте снова.":
    "qplay is not installed. Install qplay and try again.",
  "Не удалось открыть qplay.": "Could not open qplay.",
  "YouTube запросил проверку на бота. Откройте видео в Edge и повторите; если не поможет, попробуйте позже или через другую сеть/VPN.":
    "YouTube requested a bot check. Open the video in Edge and try again. If it persists, try later or use another network or VPN.",
  "YouTube требует входа или подтверждения возраста. Войдите в Edge на YouTube и повторите.":
    "YouTube requires sign-in or age verification. Sign in to YouTube in Edge and try again.",
  "YouTube отклонил медиассылку (403). Повторите загрузку; проверьте доступ к YouTube и VPN.":
    "YouTube rejected the media link (403). Retry the download and check access to YouTube and your VPN.",
  "Видео недоступно: оно скрыто, удалено или ограничено в вашем регионе.":
    "This video is private, removed or unavailable in your region.",
  "Не удалось подключиться к YouTube. Проверьте интернет и VPN, затем повторите.":
    "Could not connect to YouTube. Check your internet connection and VPN, then try again.",
  "Инструмент не ответил вовремя. Попробуйте снова.":
    "The download tool timed out. Try again.",
  "Инструмент загрузки завершился с ошибкой. Повторите попытку.":
    "The download tool failed. Try again.",
  "Скачать текущее видео Rutube": "Download the current Rutube video",
  "Скачать медиа текущего поста": "Download media from the current post",
  "Скачать текущее видео VK": "Download the current VK video",
  "Конвертируем GIF: {percentage}%": "Converting GIF: {percentage}%",
  "Загрузка видео Rutube отменена": "Rutube download canceled",
  "Видео Rutube скачано": "Rutube video downloaded",
  "Загрузка видео Rutube: {percentage}%":
    "Downloading Rutube video: {percentage}%",
  "Не удалось скачать видео Rutube. Обновите страницу и повторите загрузку.":
    "Could not download the Rutube video. Reload the page and try again.",
  "Подготавливаем видео Rutube…": "Preparing Rutube video…",
  "Видео Rutube в очереди загрузки": "Rutube video queued",
  "Сохраняем видео Rutube…": "Saving Rutube video…",
  "Не удалось скачать видео Rutube": "Rutube download failed",
  "Не удалось открыть qcatch. Нажмите иконку ещё раз.":
    "Could not open qcatch. Click its icon again.",
  "Ищем медиа…": "Finding media…",
  "Запущено загрузок: {count}": "Downloads started: {count}",
  "Часть медиа не скачалась": "Some media could not be downloaded",
  "Запущено {count} из {total}.": "Started {count} of {total}.",
  "Не удалось скачать медиа с этой страницы.":
    "Could not download media from this page.",
  "Подготавливаем GIF…": "Preparing GIF…",
  "Не удалось преобразовать зацикленное видео в GIF.":
    "Could not convert the looping video to GIF.",
} as const;

export type Message = keyof typeof english;
export type Translator = (
  message: Message,
  values?: Record<string, string | number>,
) => string;

export function browserLanguage(languages: readonly string[]): Language {
  return languages[0]?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function translate(
  language: Language,
  message: Message,
  values: Record<string, string | number> = {},
): string {
  const text = language === "ru" ? message : english[message];
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    String(values[key] ?? placeholder),
  );
}

export function itemCount(
  language: Language,
  count: number,
  kind: "episodes" | "files" | "audio" | "subtitles",
): string {
  if (language === "en") {
    const singular = {
      episodes: "episode",
      files: "file",
      audio: "audio track",
      subtitles: "subtitle track",
    }[kind];
    return `${count} ${singular}${count === 1 ? "" : "s"}`;
  }
  const forms = {
    episodes: ["серию", "серии", "серий"],
    files: ["файл", "файла", "файлов"],
    audio: ["озвучка", "озвучки", "озвучек"],
    subtitles: ["набор субтитров", "набора субтитров", "наборов субтитров"],
  }[kind];
  const lastTwo = count % 100;
  const last = count % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14
      ? forms[2]
      : last === 1
        ? forms[0]
        : last >= 2 && last <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}

export function errorTranslation(
  language: Language,
  detail: string,
): { message: string; detail?: string } {
  if (detail === "capture_expired") {
    return { message: translate(language, "Выбранное видео изменилось или передача устарела. Откройте qcatch и передайте видео заново.") };
  }
  if (language === "ru") {
    const sourceHttp = detail.match(
      /^The source returned HTTP (\d+)\. Reload the page and retry\.$/,
    );
    if (sourceHttp)
      return {
        message: `Источник вернул HTTP ${sourceHttp[1]}. Обновите страницу и повторите.`,
      };
    if (detail.startsWith("The file is incomplete or contains a preview (")) {
      return {
        message:
          "Файл неполный или содержит превью. Откройте полное медиа в плеере источника и повторите.",
      };
    }
    const message =
      Object.entries(english).find(
        ([, translation]) => translation === detail,
      )?.[0] ?? detail;
    return { message };
  }
  if (!/[А-Яа-яЁё]/.test(detail)) return { message: detail };
  if (detail in english)
    return { message: translate(language, detail as Message) };
  const http = detail.match(/^HTTP (\d+) при загрузке (.+)$/);
  if (http)
    return { message: `HTTP ${http[1]} while downloading from ${http[2]}.` };
  const server = detail.match(/^Сервер вернул (\d+)$/);
  if (server) return { message: `The server returned HTTP ${server[1]}.` };
  const player = detail.match(
    /^Плеер (.+) не отдал ни одного доступного потока$/,
  );
  if (player) return { message: `${player[1]} returned no available streams.` };
  return {
    message: translate(
      language,
      "Не удалось выполнить действие. Откройте страницу и попробуйте снова.",
    ),
    detail,
  };
}
