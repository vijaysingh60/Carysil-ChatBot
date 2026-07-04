import registry from "@/prompts/registry.json";

type PromptKey = keyof typeof registry;

export function getPrompt(key: PromptKey): string {
  return registry[key].system;
}
