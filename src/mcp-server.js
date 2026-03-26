#!/usr/bin/env node
import "dotenv/config";

import fs from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  SUMMARY_LANGUAGES,
  buildCheckpointKey,
  connectTelegram,
  describePeriod,
  fetchMessages,
  filterDialogsByActivity,
  getExactMessageCount,
  listDialogs,
  loadCheckpoints,
  loadLlmProviders,
  preprocessMessages,
  readSessionString,
  resolveLlmSelection,
  resolveOutputFormats,
  resolvePeriod,
  resolveRunMode,
  resolveSummaryLanguage,
  saveCheckpoints,
  saveOutputs,
  summarizeMessages,
} from "./index.js";

const DEFAULT_TOOL_MESSAGE_LIMIT = Number(process.env.MESSAGE_LIMIT || 300);

function ensurePositiveLimit(value, fallback = DEFAULT_TOOL_MESSAGE_LIMIT) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive number.");
  }
  return Math.floor(parsed);
}

function requireResolvedPeriod(value, fieldName) {
  const period = resolvePeriod(value || "all");
  if (!period) {
    throw new Error(`Invalid ${fieldName}. Use one of: day, week, month, all.`);
  }
  return period;
}

function requireResolvedRunMode(value) {
  const mode = resolveRunMode(value || "full");
  if (!mode) {
    throw new Error("Invalid mode. Use one of: full, incremental, changes.");
  }
  return mode;
}

function requireResolvedOutputFormats(value) {
  const formats = resolveOutputFormats(value);
  if (!formats) {
    throw new Error("Invalid outputFormats. Use one or more of: messages, markdown, structured, html, all.");
  }
  return formats;
}

async function connectTelegramForMcp() {
  const sessionString = await readSessionString();
  if (!sessionString) {
    throw new Error(
      "No saved Telegram session found. Run `npm start` once locally and complete login before using the MCP server.",
    );
  }

  return connectTelegram();
}

function matchDialog(dialogs, dialogRef) {
  const normalized = String(dialogRef || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("dialogRef is required.");
  }

  const dialog = dialogs.find(
    (item) =>
      item.id === dialogRef ||
      String(item.index) === normalized ||
      item.title.toLowerCase().includes(normalized),
  );

  if (!dialog) {
    throw new Error(`Dialog "${dialogRef}" not found in available dialogs.`);
  }

  return dialog;
}

function buildJsonText(value) {
  return {
    type: "text",
    text: JSON.stringify(value, null, 2),
  };
}

function normalizeCheckpointEntry(key, checkpoint) {
  return {
    checkpointKey: key,
    dialogId: checkpoint.dialogId,
    dialogTitle: checkpoint.dialogTitle,
    period: checkpoint.period,
    lastProcessedMessageId: checkpoint.lastProcessedMessageId ?? null,
    lastProcessedMessageDate: checkpoint.lastProcessedMessageDate ?? null,
    lastRunAt: checkpoint.lastRunAt ?? null,
    lastMode: checkpoint.lastMode ?? null,
    summaryPath: checkpoint.summaryPath ?? null,
    structuredPath: checkpoint.structuredPath ?? null,
    htmlPath: checkpoint.htmlPath ?? null,
    note: checkpoint.note ?? null,
  };
}

function matchCheckpoint(entries, dialogRef, period) {
  const normalizedDialogRef = String(dialogRef || "").trim().toLowerCase();

  let filtered = entries;
  if (normalizedDialogRef) {
    filtered = filtered.filter(
      (entry) =>
        String(entry.dialogId || "").toLowerCase() === normalizedDialogRef ||
        String(entry.dialogTitle || "").toLowerCase().includes(normalizedDialogRef),
    );
  }

  if (period) {
    filtered = filtered.filter((entry) => entry.period === period);
  }

  filtered.sort((left, right) => {
    const leftTime = new Date(left.lastRunAt || 0).getTime();
    const rightTime = new Date(right.lastRunAt || 0).getTime();
    return rightTime - leftTime;
  });

  return filtered[0] || null;
}

async function readTextFileIfExists(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFileIfExists(filePath) {
  const raw = await readTextFileIfExists(filePath);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const server = new McpServer({
  name: "telegram-digest-mcp",
  version: "1.0.0",
});

server.registerTool(
  "list_dialogs",
  {
    description: "List Telegram dialogs available to the current logged-in account.",
    inputSchema: {
      activityPeriod: z
        .enum(["day", "week", "month", "all"])
        .optional()
        .describe("Filter dialogs that have new messages in this recent period."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional limit for how many dialogs to fetch before filtering."),
    },
    outputSchema: {
      activityPeriod: z.string(),
      dialogs: z.array(
        z.object({
          index: z.number(),
          id: z.string(),
          title: z.string(),
          unreadCount: z.number(),
          lastMessageDate: z.string().nullable(),
        }),
      ),
    },
  },
  async ({ activityPeriod, limit } = {}) => {
    const client = await connectTelegramForMcp();
    try {
      const period = requireResolvedPeriod(activityPeriod || "all", "activityPeriod");
      const dialogs = filterDialogsByActivity(await listDialogs(client, limit), period).map((dialog) => ({
        index: dialog.index,
        id: dialog.id,
        title: dialog.title,
        unreadCount: dialog.unreadCount,
        lastMessageDate: dialog.lastMessageDate,
      }));

      const result = {
        activityPeriod: period,
        dialogs,
      };

      return {
        content: [buildJsonText(result)],
        structuredContent: result,
      };
    } finally {
      await client.disconnect();
    }
  },
);

server.registerTool(
  "get_dialog_messages",
  {
    description:
      "Fetch normalized text messages from a Telegram dialog by dialog id, dialog number, or title fragment.",
    inputSchema: {
      dialogRef: z
        .string()
        .describe("Dialog id, printed dialog number, or a unique title fragment from list_dialogs."),
      period: z.enum(["day", "week", "month", "all"]).optional(),
      limit: z.number().int().positive().optional(),
      activityPeriod: z
        .enum(["day", "week", "month", "all"])
        .optional()
        .describe("Optional pre-filter for the dialog list before matching dialogRef."),
      preprocess: z
        .boolean()
        .optional()
        .describe("When true, remove trivial short messages and merge adjacent same-sender messages."),
    },
    outputSchema: {
      dialog: z.object({
        id: z.string(),
        title: z.string(),
      }),
      period: z.string(),
      exactMessageCount: z.number(),
      scannedCount: z.number(),
      skippedNonTextCount: z.number(),
      skippedByCheckpointCount: z.number(),
      droppedShortMessages: z.number(),
      mergedGroups: z.number(),
      messages: z.array(
        z.object({
          id: z.number(),
          date: z.string().nullable(),
          senderId: z.string().nullable(),
          senderLabel: z.string(),
          text: z.string(),
        }),
      ),
    },
  },
  async ({ dialogRef, period, limit, activityPeriod, preprocess = true }) => {
    const client = await connectTelegramForMcp();
    try {
      const selectedActivityPeriod = requireResolvedPeriod(activityPeriod || "all", "activityPeriod");
      const dialogs = filterDialogsByActivity(await listDialogs(client), selectedActivityPeriod);
      const dialog = matchDialog(dialogs, dialogRef);
      const selectedPeriod = requireResolvedPeriod(period || "all", "period");
      const messageLimit = ensurePositiveLimit(limit);
      const exactMessageCount = await getExactMessageCount(client, dialog.entity);
      const fetchResult = await fetchMessages(client, dialog.entity, messageLimit, selectedPeriod);
      const preprocessResult = preprocess ? preprocessMessages(fetchResult.messages) : {
        messages: fetchResult.messages,
        droppedShortMessages: 0,
        mergedGroups: 0,
      };

      const result = {
        dialog: {
          id: dialog.id,
          title: dialog.title,
        },
        period: selectedPeriod,
        exactMessageCount,
        scannedCount: fetchResult.scannedCount,
        skippedNonTextCount: fetchResult.skippedNonTextCount,
        skippedByCheckpointCount: fetchResult.skippedByCheckpointCount,
        droppedShortMessages: preprocessResult.droppedShortMessages,
        mergedGroups: preprocessResult.mergedGroups,
        messages: preprocessResult.messages.map((message) => ({
          id: message.id,
          date: message.date,
          senderId: message.senderId,
          senderLabel: message.senderLabel || message.senderId || "unknown",
          text: message.text,
        })),
      };

      return {
        content: [buildJsonText(result)],
        structuredContent: result,
      };
    } finally {
      await client.disconnect();
    }
  },
);

server.registerTool(
  "summarize_dialog",
  {
    description: "Summarize a Telegram dialog and optionally save messages/markdown/json/html output files.",
    inputSchema: {
      dialogRef: z
        .string()
        .describe("Dialog id, printed dialog number, or a unique title fragment from list_dialogs."),
      period: z.enum(["day", "week", "month", "all"]).optional(),
      limit: z.number().int().positive().optional(),
      mode: z.enum(["full", "incremental", "changes"]).optional(),
      activityPeriod: z.enum(["day", "week", "month", "all"]).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      language: z.string().optional(),
      saveOutputs: z.boolean().optional(),
      outputFormats: z
        .array(z.enum(["messages", "markdown", "structured", "html"]))
        .optional()
        .describe("Optional list of output files to save. Defaults to all formats."),
    },
    outputSchema: {
      dialog: z.object({
        id: z.string(),
        title: z.string(),
      }),
      period: z.string(),
      mode: z.string(),
      language: z.string(),
      llm: z.object({
        providerId: z.string(),
        modelId: z.string(),
      }),
      exactMessageCount: z.number(),
      selectedMessageCount: z.number(),
      summary: z.string(),
      files: z
        .object({
          outputFormats: z.array(z.string()),
          messagesPath: z.union([z.string(), z.null()]),
          summaryPath: z.union([z.string(), z.null()]),
          structuredPath: z.union([z.string(), z.null()]),
          htmlPath: z.union([z.string(), z.null()]),
        })
        .nullable(),
    },
  },
  async ({
    dialogRef,
    period,
    limit,
    mode,
    activityPeriod,
    provider,
    model,
    language,
    saveOutputs: shouldSaveOutputs = true,
    outputFormats,
  }) => {
    const client = await connectTelegramForMcp();
    try {
      const selectedActivityPeriod = requireResolvedPeriod(activityPeriod || "all", "activityPeriod");
      const dialogs = filterDialogsByActivity(await listDialogs(client), selectedActivityPeriod);
      const dialog = matchDialog(dialogs, dialogRef);
      const selectedPeriod = requireResolvedPeriod(period || "all", "period");
      const selectedMode = requireResolvedRunMode(mode || "full");
      const summaryLanguage =
        resolveSummaryLanguage(language || process.env.SUMMARY_LANGUAGE) || resolveSummaryLanguage("en");
      const selectedOutputFormats = requireResolvedOutputFormats(outputFormats);
      const llmSelection = await resolveLlmSelection({ provider, model });
      const messageLimit = ensurePositiveLimit(limit);
      const exactMessageCount = await getExactMessageCount(client, dialog.entity);
      const checkpoints = await loadCheckpoints();
      const checkpointKey = buildCheckpointKey(dialog.id, selectedPeriod);
      const checkpoint = checkpoints[checkpointKey];
      const minMessageIdExclusive =
        selectedMode === "full" ? 0 : Number(checkpoint?.lastProcessedMessageId || 0);

      const fetchResult = await fetchMessages(client, dialog.entity, messageLimit, selectedPeriod, {
        minMessageIdExclusive,
      });
      const preprocessResult = preprocessMessages(fetchResult.messages);
      const newestFetchedMessage = fetchResult.messages[fetchResult.messages.length - 1];

      if (preprocessResult.messages.length === 0) {
        if ((selectedMode === "incremental" || selectedMode === "changes") && newestFetchedMessage) {
          checkpoints[checkpointKey] = {
            dialogId: dialog.id,
            dialogTitle: dialog.title,
            period: selectedPeriod,
            lastProcessedMessageId: newestFetchedMessage.id,
            lastProcessedMessageDate: newestFetchedMessage.date,
            lastRunAt: new Date().toISOString(),
            lastMode: selectedMode,
            note: "Checkpoint advanced without summary because only trivial text messages were found.",
          };
          await saveCheckpoints(checkpoints);
        }

        const emptyResult = {
          dialog: {
            id: dialog.id,
            title: dialog.title,
          },
          period: selectedPeriod,
          mode: selectedMode,
          language: summaryLanguage.id,
          llm: {
            providerId: llmSelection.provider.id,
            modelId: llmSelection.modelId,
          },
          exactMessageCount,
          selectedMessageCount: 0,
          summary: "No new text messages found for summarization.",
          files: null,
        };

        return {
          content: [buildJsonText(emptyResult)],
          structuredContent: emptyResult,
        };
      }

      const summaryTitle =
        selectedMode === "changes" ? `${dialog.title} (changes since last summary)` : dialog.title;
      const summary = await summarizeMessages(
        preprocessResult.messages,
        summaryTitle,
        llmSelection,
        summaryLanguage,
      );

      let files = null;
      if (shouldSaveOutputs) {
        files = await saveOutputs(
          dialog,
          preprocessResult.messages,
          summary,
          summaryLanguage,
          selectedOutputFormats,
        );
      }

      checkpoints[checkpointKey] = {
        dialogId: dialog.id,
        dialogTitle: dialog.title,
        period: selectedPeriod,
        lastProcessedMessageId: newestFetchedMessage?.id || minMessageIdExclusive,
        lastProcessedMessageDate: newestFetchedMessage?.date || checkpoint?.lastProcessedMessageDate || null,
        lastRunAt: new Date().toISOString(),
        lastMode: selectedMode,
        summaryPath: files?.summaryPath,
        structuredPath: files?.structuredPath,
        htmlPath: files?.htmlPath,
      };
      await saveCheckpoints(checkpoints);

      const result = {
        dialog: {
          id: dialog.id,
          title: dialog.title,
        },
        period: selectedPeriod,
        mode: selectedMode,
        language: summaryLanguage.id,
        llm: {
          providerId: llmSelection.provider.id,
          modelId: llmSelection.modelId,
        },
        exactMessageCount,
        selectedMessageCount: preprocessResult.messages.length,
        summary,
        files,
      };

      return {
        content: [
          {
            type: "text",
            text: `Summary created for "${dialog.title}" (${describePeriod(selectedPeriod)}).`,
          },
          buildJsonText(result),
        ],
        structuredContent: result,
      };
    } finally {
      await client.disconnect();
    }
  },
);

server.registerTool(
  "list_llm_providers",
  {
    description: "List configured LLM providers and their available models.",
    outputSchema: {
      providers: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          apiType: z.string(),
          defaultModel: z.string().nullable(),
          models: z.array(z.string()),
        }),
      ),
    },
  },
  async () => {
    const providers = (await loadLlmProviders()).map((provider) => ({
      id: provider.id,
      label: provider.label || provider.id,
      apiType: provider.apiType,
      defaultModel: provider.defaultModel || null,
      models: Array.isArray(provider.models)
        ? provider.models.map((model) => (typeof model === "string" ? model : model.id))
        : [],
    }));

    const result = { providers };
    return {
      content: [buildJsonText(result)],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "list_summary_languages",
  {
    description: "List supported summary output languages.",
    outputSchema: {
      languages: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          nativeLabel: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    },
  },
  async () => {
  const defaultLanguageId = resolveSummaryLanguage(process.env.SUMMARY_LANGUAGE)?.id || "en";
    const languages = Object.values(SUMMARY_LANGUAGES).map((language) => ({
      id: language.id,
      label: language.label,
      nativeLabel: language.nativeLabel,
      isDefault: language.id === defaultLanguageId,
    }));

    const result = { languages };
    return {
      content: [buildJsonText(result)],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "get_last_summary",
  {
    description:
      "Read the most recent saved summary from local checkpoints and linked report files, optionally filtered by dialog and period.",
    inputSchema: {
      dialogRef: z
        .string()
        .optional()
        .describe("Optional dialog id or dialog title fragment to filter checkpoints."),
      period: z
        .enum(["day", "week", "month", "all"])
        .optional()
        .describe("Optional period to filter checkpoints."),
      includeMarkdown: z.boolean().optional().describe("Include the saved markdown report content."),
      includeStructured: z.boolean().optional().describe("Include the parsed summary JSON content."),
      includeHtml: z.boolean().optional().describe("Include the saved HTML report content."),
    },
    outputSchema: {
      checkpoint: z
        .object({
          checkpointKey: z.string(),
          dialogId: z.string(),
          dialogTitle: z.string(),
          period: z.string(),
          lastProcessedMessageId: z.union([z.number(), z.null()]),
          lastProcessedMessageDate: z.union([z.string(), z.null()]),
          lastRunAt: z.union([z.string(), z.null()]),
          lastMode: z.union([z.string(), z.null()]),
          summaryPath: z.union([z.string(), z.null()]),
          structuredPath: z.union([z.string(), z.null()]),
          htmlPath: z.union([z.string(), z.null()]),
          note: z.union([z.string(), z.null()]),
        })
        .nullable(),
      markdownReport: z.union([z.string(), z.null()]),
      structuredSummary: z.union([z.record(z.string(), z.unknown()), z.null()]),
      htmlReport: z.union([z.string(), z.null()]),
    },
  },
  async ({ dialogRef, period, includeMarkdown = true, includeStructured = true, includeHtml = false } = {}) => {
    const selectedPeriod = period ? requireResolvedPeriod(period, "period") : null;
    const checkpoints = await loadCheckpoints();
    const entries = Object.entries(checkpoints).map(([key, checkpoint]) => normalizeCheckpointEntry(key, checkpoint));
    const checkpoint = matchCheckpoint(entries, dialogRef, selectedPeriod);

    if (!checkpoint) {
      const emptyResult = {
        checkpoint: null,
        markdownReport: null,
        structuredSummary: null,
        htmlReport: null,
      };

      return {
        content: [
          {
            type: "text",
            text: "No matching saved summary was found in local checkpoints.",
          },
          buildJsonText(emptyResult),
        ],
        structuredContent: emptyResult,
      };
    }

    const result = {
      checkpoint,
      markdownReport: includeMarkdown ? await readTextFileIfExists(checkpoint.summaryPath) : null,
      structuredSummary: includeStructured ? await readJsonFileIfExists(checkpoint.structuredPath) : null,
      htmlReport: includeHtml ? await readTextFileIfExists(checkpoint.htmlPath) : null,
    };

    return {
      content: [
        {
          type: "text",
          text: `Loaded last saved summary for "${checkpoint.dialogTitle}" (${describePeriod(checkpoint.period)}).`,
        },
        buildJsonText({
          checkpoint: result.checkpoint,
          markdownIncluded: Boolean(result.markdownReport),
          structuredIncluded: Boolean(result.structuredSummary),
          htmlIncluded: Boolean(result.htmlReport),
        }),
      ],
      structuredContent: result,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Telegram Digest MCP server running on stdio");
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
