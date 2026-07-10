import {
  BUILT_IN_BASE_PROMPT,
  BUILT_IN_NEGATIVE_PROMPT,
  BUILT_IN_PROMPT_VERSION,
} from "../../core/promptTemplates";
import type { PromptSettings } from "../../core/sourceImage";

const STORAGE_KEY = "gif-craft.prompt-settings.v1";

export function defaultPromptSettings(): PromptSettings {
  return {
    basePrompt: BUILT_IN_BASE_PROMPT,
    negativePrompt: BUILT_IN_NEGATIVE_PROMPT,
    version: BUILT_IN_PROMPT_VERSION,
  };
}

export function loadPromptSettings(): PromptSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPromptSettings();
    const parsed = JSON.parse(raw) as Partial<PromptSettings>;
    if (
      typeof parsed.basePrompt !== "string" ||
      typeof parsed.negativePrompt !== "string" ||
      typeof parsed.version !== "number"
    ) {
      return defaultPromptSettings();
    }
    return parsed as PromptSettings;
  } catch {
    return defaultPromptSettings();
  }
}

export function savePromptSettings(settings: PromptSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
