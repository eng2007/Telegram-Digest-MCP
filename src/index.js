import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import input from "input";

import { SUMMARY_LANGUAGES } from "../config/summary-languages.js";
import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_RUN_MODE,
  buildCheckpointKey,
  describePeriod,
  describeRunMode,
  loadCheckpoints,
  loadLlmProviders,
  loadSummaryPrompts,
  parseArgs,
  readChunkCache,
  renderPrompt,
  resolveLlmSelection,
  resolvePeriod,
  resolveProvider,
  resolveProviderModel,
  resolveRunMode,
  resolveSummaryLanguage,
  saveCheckpoints,
  sleep,
  writeChunkCache,
} from "./lib/config.js";
import {
  buildMarkdownReport,
  buildStructuredSummary,
  extractBulletItems,
  extractSection,
  saveOutputs,
} from "./lib/reports.js";
import {
  buildPromptLanguageVariables,
  callLlm,
  chunkMessages,
  resolveSummaryConcurrency,
  summarizeMessages,
} from "./lib/summarizer.js";
import {
  connectTelegram,
  fetchMessages,
  filterDialogsByActivity,
  formatMessage,
  getExactMessageCount,
  getTelegramProxy,
  isTrivialText,
  listDialogs,
  normalizeMessageDate,
  normalizeText,
  preprocessMessages,
  readSessionString,
  writeSessionString,
} from "./lib/telegram.js";

const __filename = fileURLToPath(import.meta.url);

async function choosePeriod(args) {
  const argPeriod = resolvePeriod(args.period);
  if (argPeriod) {
    return argPeriod;
  }

  console.log("\nChoose period:");
  console.log("1. Day");
  console.log("2. Week");
  console.log("3. Month");
  console.log("4. All from the beginning");

  const selected = await input.text("\nPeriod number: ");
  const period = resolvePeriod(selected);

  if (!period) {
    throw new Error("Invalid period selection.");
  }

  return period;
}

async function chooseDialogActivityPeriod(args) {
  const argPeriod = resolvePeriod(args.dialogPeriod || args["dialog-period"]);
  if (argPeriod) {
    return argPeriod;
  }

  console.log("\nFilter dialogs by new messages in:");
  console.log("1. Day");
  console.log("2. Week");
  console.log("3. Month");
  console.log("4. All time");

  const selected = await input.text("\nDialog filter number: ");
  const period = resolvePeriod(selected);

  if (!period) {
    throw new Error("Invalid dialog filter selection.");
  }

  return period;
}

async function chooseDialog(client, args, dialogPeriod) {
  const parsedLimit = args.dialogs ? Number(args.dialogs) : undefined;
  const dialogs = filterDialogsByActivity(await listDialogs(client, parsedLimit), dialogPeriod);

  if (dialogs.length === 0) {
    throw new Error("No dialogs available for the selected activity period.");
  }

  console.log("\nAvailable dialogs:");
  for (const dialog of dialogs) {
    console.log(`${dialog.index}. ${dialog.title} [id=${dialog.id}] unread=${dialog.unreadCount}`);
  }

  if (args.chat) {
    const lowered = String(args.chat).toLowerCase();
    const matched = dialogs.find(
      (dialog) =>
        dialog.id === args.chat ||
        dialog.title.toLowerCase().includes(lowered) ||
        String(dialog.index) === args.chat,
    );

    if (matched) {
      return matched;
    }
  }

  const selected = await input.text("\nChoose dialog number: ");
  const chosen = dialogs.find((dialog) => String(dialog.index) === selected.trim());

  if (!chosen) {
    throw new Error("Invalid dialog selection.");
  }

  return chosen;
}

export async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const messageLimit = Number(args.limit || DEFAULT_MESSAGE_LIMIT);
  const runMode = resolveRunMode(args.mode || DEFAULT_RUN_MODE) || "full";
  const summaryLanguage = resolveSummaryLanguage(args.language || process.env.SUMMARY_LANGUAGE) || SUMMARY_LANGUAGES.en;

  if (!Number.isFinite(messageLimit) || messageLimit <= 0) {
    throw new Error("Message limit must be a positive number.");
  }

  const client = await connectTelegram();

  try {
    const llmSelection = await resolveLlmSelection(args);
    console.log(
      `Selected LLM: ${llmSelection.provider.label} / ${llmSelection.modelLabel} (${llmSelection.modelId})`,
    );
    console.log(`Summary language: ${summaryLanguage.nativeLabel} (${summaryLanguage.id})`);
    const dialogActivityPeriod = await chooseDialogActivityPeriod(args);
    console.log(`Dialog activity filter: ${describePeriod(dialogActivityPeriod)}`);
    const dialog = await chooseDialog(client, args, dialogActivityPeriod);
    const exactMessageCount = await getExactMessageCount(client, dialog.entity);
    const period = await choosePeriod(args);
    const checkpoints = await loadCheckpoints();
    const checkpointKey = buildCheckpointKey(dialog.id, period);
    const checkpoint = checkpoints[checkpointKey];
    const minMessageIdExclusive = runMode === "full" ? 0 : Number(checkpoint?.lastProcessedMessageId || 0);
    console.log(`Exact total messages in dialog: ${exactMessageCount}`);
    console.log(`Selected period: ${period}`);
    console.log(`Run mode: ${describeRunMode(runMode)}`);
    if (minMessageIdExclusive > 0) {
      console.log(`Using checkpoint after message id ${minMessageIdExclusive}.`);
    }
    console.log(`\nFetching up to ${messageLimit} messages from "${dialog.title}"...`);
    const {
      messages: fetchedMessages,
      scannedCount,
      skippedNonTextCount,
      skippedByCheckpointCount,
    } = await fetchMessages(client, dialog.entity, messageLimit, period, { minMessageIdExclusive });
    const { messages: filteredMessages, droppedShortMessages, mergedGroups } = preprocessMessages(fetchedMessages);
    const newestFetchedMessage = fetchedMessages[fetchedMessages.length - 1];

    if (filteredMessages.length === 0) {
      if (runMode === "incremental" || runMode === "changes") {
        if (newestFetchedMessage) {
          checkpoints[checkpointKey] = {
            dialogId: dialog.id,
            dialogTitle: dialog.title,
            period,
            lastProcessedMessageId: newestFetchedMessage.id,
            lastProcessedMessageDate: newestFetchedMessage.date,
            lastRunAt: new Date().toISOString(),
            lastMode: runMode,
            note: "Checkpoint advanced without summary because only trivial text messages were found.",
          };
          await saveCheckpoints(checkpoints);
        }
        console.log("No new text messages found since the last summary checkpoint.");
        return;
      }

      throw new Error("No text messages found in the selected dialog for the chosen period.");
    }

    console.log(`Scanned ${scannedCount} messages in the selected period.`);
    console.log(`Selected ${filteredMessages.length} text messages for summarization.`);
    if (skippedNonTextCount > 0) {
      console.log(`Skipped ${skippedNonTextCount} non-text or empty messages.`);
    }
    if (skippedByCheckpointCount > 0) {
      console.log(`Stopped at checkpoint boundary after ${skippedByCheckpointCount} already-processed messages.`);
    }
    if (droppedShortMessages > 0) {
      console.log(`Dropped ${droppedShortMessages} trivial short messages during cleanup.`);
    }
    if (mergedGroups > 0) {
      console.log(`Merged ${mergedGroups} adjacent messages from the same sender.`);
    }
    console.log("Starting LLM summarization...");
    const summaryTitle =
      runMode === "changes" ? `${dialog.title} (changes since last summary)` : dialog.title;
    const summary = await summarizeMessages(filteredMessages, summaryTitle, llmSelection, summaryLanguage);
    const files = await saveOutputs(dialog, filteredMessages, summary, summaryLanguage);
    checkpoints[checkpointKey] = {
      dialogId: dialog.id,
      dialogTitle: dialog.title,
      period,
      lastProcessedMessageId: newestFetchedMessage?.id || minMessageIdExclusive,
      lastProcessedMessageDate: newestFetchedMessage?.date || checkpoint?.lastProcessedMessageDate || null,
      lastRunAt: new Date().toISOString(),
      lastMode: runMode,
      summaryPath: files.summaryPath,
      structuredPath: files.structuredPath,
      htmlPath: files.htmlPath,
    };
    await saveCheckpoints(checkpoints);

    console.log("\nDone.");
    console.log(`Messages saved to: ${files.messagesPath}`);
    console.log(`Summary saved to: ${files.summaryPath}`);
    console.log(`Structured summary saved to: ${files.structuredPath}`);
    console.log(`HTML report saved to: ${files.htmlPath}`);
  } finally {
    await client.disconnect();
  }
}

export {
  SUMMARY_LANGUAGES,
  buildCheckpointKey,
  buildMarkdownReport,
  buildPromptLanguageVariables,
  buildStructuredSummary,
  callLlm,
  chunkMessages,
  connectTelegram,
  describePeriod,
  describeRunMode,
  extractBulletItems,
  extractSection,
  fetchMessages,
  filterDialogsByActivity,
  formatMessage,
  getExactMessageCount,
  getTelegramProxy,
  isTrivialText,
  listDialogs,
  loadCheckpoints,
  loadLlmProviders,
  loadSummaryPrompts,
  normalizeMessageDate,
  normalizeText,
  parseArgs,
  preprocessMessages,
  readChunkCache,
  readSessionString,
  renderPrompt,
  resolveLlmSelection,
  resolvePeriod,
  resolveProvider,
  resolveProviderModel,
  resolveRunMode,
  resolveSummaryConcurrency,
  resolveSummaryLanguage,
  saveCheckpoints,
  saveOutputs,
  sleep,
  summarizeMessages,
  writeChunkCache,
  writeSessionString,
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((error) => {
    console.error(`\nError: ${error.message}`);
    process.exitCode = 1;
  });
}
