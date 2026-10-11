import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import {
  browserLanguage,
  errorTranslation,
  translate,
  type Language,
  type Translator,
} from "../shared/localization.ts";

const LanguageContext = createContext<
  | {
      language: Language;
      setLanguage: (language: Language) => void;
      t: Translator;
    }
  | undefined
>(undefined);

export function LanguageProvider({
  children,
}: {
  children: ComponentChildren;
}) {
  const [language, updateLanguage] = useState<Language>(
    browserLanguage(navigator.languages),
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void chrome.storage.local
      .get("language")
      .then((saved) => {
        if (saved.language === "ru" || saved.language === "en")
          updateLanguage(saved.language);
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const context = useMemo(
    () => ({
      language,
      setLanguage(next: Language) {
        updateLanguage(next);
        void chrome.storage.local
          .set({ language: next })
          .catch(() => undefined);
      },
      t: ((message, values) =>
        translate(language, message, values)) as Translator,
    }),
    [language],
  );

  return (
    <LanguageContext.Provider value={context}>
      {ready && children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LanguageProvider is missing");
  return context;
}

export function Header() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <header class="header">
      <div class="brand">
        <img src="../icons/icon-32.png" alt="" />
        <strong>qcatch</strong>
      </div>
      <select
        aria-label={t("Язык")}
        class="language-select"
        value={language}
        onChange={(event) => setLanguage(event.currentTarget.value as Language)}
      >
        <option value="ru">Русский</option>
        <option value="en">English</option>
      </select>
    </header>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  const { language, t } = useLanguage();
  const error = errorTranslation(language, message);
  return (
    <div class="notice error" role="alert">
      {error.message}
      {error.detail && (
        <details class="error-details">
          <summary>{t("Подробности")}</summary>
          <p>{error.detail}</p>
        </details>
      )}
    </div>
  );
}
