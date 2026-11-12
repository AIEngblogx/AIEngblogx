const LANGUAGE_NAMES: Record<string, string> = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "fr-FR": "French",
  "de-DE": "German",
  "es-ES": "Spanish",
  "pt-BR": "Brazilian Portuguese",
  "ru-RU": "Russian",
  "it-IT": "Italian",
};

export function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag] ?? tag;
}
