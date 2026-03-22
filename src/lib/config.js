import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUMMARY_LANGUAGES } from "../../config/summary-languages.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "../..");
export const OUTPUT_DIR = path.join(ROOT_DIR, "output");
export const SESSION_FILE = path.join(ROOT_DIR, ".telegram-session.txt");
export const PROMPTS_FILE = path.join(ROOT_DIR, "config", "summary-prompts.json");
export const LLM_PROVIDERS_FILE = path.join(ROOT_DIR, "config", "llm-providers.json");
export const CACHE_DIR = path.join(ROOT_DIR, ".cache", "summary-chunks");
export const STATE_DIR = path.join(ROOT_DIR, ".state");
export const CHECKPOINTS_FILE = path.join(STATE_DIR, "checkpoints.json");

export const DEFAULT_MESSAGE_LIMIT = Number(process.env.MESSAGE_LIMIT || 300);
export const DEFAULT_SUMMARY_CONCURRENCY = Number(process.env.SUMMARY_CONCURRENCY || 3);
export const DEFAULT_MERGE_WINDOW_MINUTES = Number(process.env.MERGE_WINDOW_MINUTES || 10);
export const DEFAULT_RUN_MODE = process.env.RUN_MODE || "full";
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 8000);

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function requireProviderField(provider, field, value) {
  if (!value) {
    throw new Error(`Missing ${field} for LLM provider "${provider.id}". Check your settings.`);
  }

  return value;
}

export async function loadLlmProviders() {
  const raw = await fs.readFile(LLM_PROVIDERS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const providers = Array.isArray(parsed?.providers) ? parsed.providers : [];

  if (!providers.length) {
    throw new Error("No LLM providers configured in config/llm-providers.json.");
  }

  return providers.map((provider) => ({
    ...provider,
    apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] || "" : "",
  }));
}

export function resolveProvider(providers, value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return providers.find(
    (provider) =>
      String(provider.id || "").toLowerCase() === normalized ||
      String(provider.label || "").toLowerCase() === normalized,
  );
}

export function resolveProviderModel(provider, value) {
  const normalized = String(value || "").trim().toLowerCase();
  const models = Array.isArray(provider?.models) ? provider.models : [];

  if (!normalized) {
    return undefined;
  }

  return models.find((model) => {
    if (typeof model === "string") {
      return model.toLowerCase() === normalized;
    }

    return (
      String(model?.id || "").toLowerCase() === normalized ||
      String(model?.label || "").toLowerCase() === normalized
    );
  });
}

export async function resolveLlmSelection(args) {
  const providers = await loadLlmProviders();
  const legacyProfile = String(args.profile || process.env.LLM_PROFILE || "").trim().toLowerCase();
  const providerId = args.provider || process.env.LLM_PROVIDER || legacyProfile;
  const provider = resolveProvider(providers, providerId);

  if (!provider) {
    throw new Error(
      `Unknown LLM provider "${providerId || "(empty)"}". Available providers: ${providers
        .map((item) => item.id)
        .join(", ")}`,
    );
  }

  const fallbackModelFromLegacy =
    legacyProfile && resolveProviderModel(provider, legacyProfile)
      ? legacyProfile
      : provider.defaultModel;
  const modelValue = args.model || process.env.LLM_MODEL || fallbackModelFromLegacy;
  const selectedModel = resolveProviderModel(provider, modelValue);

  if (!selectedModel) {
    const availableModels = (provider.models || []).map((item) =>
      typeof item === "string" ? item : item.id,
    );
    throw new Error(
      `Unknown model "${modelValue || "(empty)"}" for provider "${provider.id}". Available models: ${availableModels.join(", ")}`,
    );
  }

  const modelId = typeof selectedModel === "string" ? selectedModel : selectedModel.id;
  const modelLabel = typeof selectedModel === "string" ? selectedModel : selectedModel.label || selectedModel.id;

  return {
    provider,
    modelId,
    modelLabel,
  };
}

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const nextValue = argv[index + 1];

    if (!nextValue || nextValue.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = nextValue;
    index += 1;
  }

  return args;
}

export function resolveSummaryLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return SUMMARY_LANGUAGES.en;
  }

  if (["ru", "rus", "russian", "рус", "русский"].includes(normalized)) {
    return SUMMARY_LANGUAGES.ru;
  }

  if (["en", "eng", "english"].includes(normalized)) {
    return SUMMARY_LANGUAGES.en;
  }

  if (["es", "spa", "spanish", "espanol", "español"].includes(normalized)) {
    return SUMMARY_LANGUAGES.es;
  }

  if (["de", "ger", "german", "deutsch"].includes(normalized)) {
    return SUMMARY_LANGUAGES.de;
  }

  if (["fr", "fre", "french", "francais", "français"].includes(normalized)) {
    return SUMMARY_LANGUAGES.fr;
  }

  if (["zh-cn", "zh", "zh-hans", "chinese", "simplified-chinese", "简体中文"].includes(normalized)) {
    return SUMMARY_LANGUAGES["zh-cn"];
  }

  return undefined;
}

export function resolvePeriod(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["1", "day", "d", "день"].includes(normalized)) {
    return "day";
  }

  if (["2", "week", "w", "неделя", "неделю"].includes(normalized)) {
    return "week";
  }

  if (["3", "month", "m", "месяц"].includes(normalized)) {
    return "month";
  }

  if (["4", "all", "a", "все", "всё", "сначала"].includes(normalized)) {
    return "all";
  }

  return undefined;
}

export function resolveRunMode(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["full", "all", "complete"].includes(normalized)) {
    return "full";
  }

  if (["incremental", "inc", "new"].includes(normalized)) {
    return "incremental";
  }

  if (["changes", "delta", "diff"].includes(normalized)) {
    return "changes";
  }

  return undefined;
}

export function describeRunMode(mode) {
  switch (mode) {
    case "incremental":
      return "incremental (only new messages since last summary)";
    case "changes":
      return "changes (summary of what changed since last summary)";
    case "full":
    default:
      return "full";
  }
}

export function describePeriod(period) {
  switch (period) {
    case "day":
      return "day";
    case "week":
      return "week";
    case "month":
      return "month";
    case "all":
      return "all time";
    default:
      return period;
  }
}

export function getPeriodStart(period) {
  const now = new Date();

  switch (period) {
    case "day":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
    default:
      throw new Error(`Unsupported period: ${period}`);
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function loadSummaryPrompts() {
  const raw = await fs.readFile(PROMPTS_FILE, "utf8");
  return JSON.parse(raw);
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadCheckpoints() {
  try {
    const raw = await fs.readFile(CHECKPOINTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveCheckpoints(checkpoints) {
  await ensureDir(STATE_DIR);
  await fs.writeFile(CHECKPOINTS_FILE, JSON.stringify(checkpoints, null, 2), "utf8");
}

export function buildCheckpointKey(dialogId, period) {
  return `${dialogId}::${period}`;
}

export function renderPrompt(template, variables) {
  return String(template).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) =>
    key in variables ? String(variables[key]) : "",
  );
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function readChunkCache(cacheKey) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${cacheKey}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.summary === "string" ? parsed.summary : null;
  } catch {
    return null;
  }
}

export async function writeChunkCache(cacheKey, payload) {
  await ensureDir(CACHE_DIR);
  await fs.writeFile(path.join(CACHE_DIR, `${cacheKey}.json`), JSON.stringify(payload, null, 2), "utf8");
}
