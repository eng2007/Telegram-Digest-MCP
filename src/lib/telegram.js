import path from "node:path";

import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import {
  DEFAULT_MERGE_WINDOW_MINUTES,
  SESSION_FILE,
  ensureDir,
  getPeriodStart,
  requireEnv,
} from "./config.js";
import { HttpProxyPromisedNetSockets } from "./http-proxy-socket.js";

import fs from "node:fs/promises";

export function resolveTelegramProxyProtocol() {
  const protocol = String(process.env.TELEGRAM_PROXY_PROTOCOL || "")
    .trim()
    .toLowerCase();
  const socksType = Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || 5);

  if (!protocol) {
    return socksType === 4 ? "socks4" : "socks5";
  }

  if (["http", "https", "socks4", "socks5", "socks5h", "socks"].includes(protocol)) {
    return protocol === "socks" || protocol === "socks5h" ? "socks5" : protocol;
  }

  throw new Error("TELEGRAM_PROXY_PROTOCOL must be one of: http, https, socks4, socks5.");
}

export function getTelegramProxy() {
  const host = process.env.TELEGRAM_PROXY_HOST?.trim();
  const port = Number(process.env.TELEGRAM_PROXY_PORT || "");
  const username = process.env.TELEGRAM_PROXY_USERNAME?.trim();
  const password = process.env.TELEGRAM_PROXY_PASSWORD?.trim();
  const protocol = resolveTelegramProxyProtocol();

  if (!host) {
    return undefined;
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("TELEGRAM_PROXY_PORT must be a positive number when TELEGRAM_PROXY_HOST is set.");
  }

  if (protocol === "http" || protocol === "https") {
    return {
      ip: host,
      port,
      protocol,
      username: username || undefined,
      password: password || undefined,
      timeout: 10,
    };
  }

  const socksType = protocol === "socks4" ? 4 : Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || 5);

  if (socksType !== 4 && socksType !== 5) {
    throw new Error("TELEGRAM_PROXY_SOCKS_TYPE must be 4 or 5.");
  }

  return {
    ip: host,
    port,
    socksType,
    username: username || undefined,
    password: password || undefined,
  };
}

export function getTelegramClientOptions() {
  const proxy = getTelegramProxy();

  if (!proxy) {
    return {
      connectionRetries: 5,
    };
  }

  if (proxy.protocol === "http" || proxy.protocol === "https") {
    return {
      connectionRetries: 5,
      proxy,
      networkSocket: HttpProxyPromisedNetSockets,
    };
  }

  return {
    connectionRetries: 5,
    proxy,
  };
}

export async function readSessionString() {
  try {
    return (await fs.readFile(SESSION_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

export async function writeSessionString(session) {
  await ensureDir(path.dirname(SESSION_FILE));
  await fs.writeFile(SESSION_FILE, session, "utf8");
}

export async function connectTelegram() {
  const apiId = Number(requireEnv("TELEGRAM_API_ID"));
  const apiHash = requireEnv("TELEGRAM_API_HASH");
  const sessionString = await readSessionString();
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    getTelegramClientOptions(),
  );

  await client.start({
    phoneNumber: async () => input.text("Telegram phone number: "),
    password: async () => input.password("2FA password (if enabled): "),
    phoneCode: async () => input.text("Code from Telegram: "),
    onError: (error) => {
      console.error("Telegram auth error:", error.message);
    },
  });

  await writeSessionString(client.session.save());
  return client;
}

export function normalizeText(value) {
  if (!value) {
    return "";
  }

  return String(value).replace(/\s+/g, " ").trim();
}

export function isTrivialText(text) {
  const normalized = normalizeText(text).toLowerCase();

  if (!normalized) {
    return true;
  }

  if (/^[+👍👌🔥❤️]+$/u.test(normalized)) {
    return true;
  }

  return new Set(["+", "++", "ok", "ок", "ага", "угу", "да", "нет", "спс", "thx"]).has(normalized);
}

export function normalizeMessageDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value?.toISOString === "function") {
    return value.toISOString();
  }

  return null;
}

function formatSenderTitle(sender) {
  if (!sender) {
    return "";
  }

  if (typeof sender.title === "string" && sender.title.trim()) {
    return sender.title.trim();
  }

  const firstName = typeof sender.firstName === "string" ? sender.firstName.trim() : "";
  const lastName = typeof sender.lastName === "string" ? sender.lastName.trim() : "";
  const fullName = `${firstName} ${lastName}`.trim();

  if (fullName) {
    return fullName;
  }

  if (typeof sender.username === "string" && sender.username.trim()) {
    return `@${sender.username.trim()}`;
  }

  return "";
}

function getMessageSender(message) {
  return (
    message.sender ||
    message._sender ||
    message.chat ||
    message._chat ||
    message.inputChat ||
    null
  );
}

function getSenderUsername(sender) {
  if (!sender) {
    return "";
  }

  if (typeof sender.username === "string" && sender.username.trim()) {
    return sender.username.trim();
  }

  const activeUsername = Array.isArray(sender.usernames)
    ? sender.usernames.find((item) => item?.active && typeof item.username === "string" && item.username.trim())
    : null;

  return activeUsername?.username?.trim() || "";
}

function formatSenderLabel(message) {
  const senderId = message.senderId?.toString?.() || null;
  const sender = getMessageSender(message);
  const senderTitle = formatSenderTitle(sender);

  if (senderTitle && senderId) {
    return `${senderTitle} (${senderId})`;
  }

  if (senderTitle) {
    return senderTitle;
  }

  if (senderId) {
    return `Unknown sender (${senderId})`;
  }

  return "unknown";
}

export function formatMessage(message) {
  const sender = getMessageSender(message);
  const senderUsername = getSenderUsername(sender);

  return {
    id: message.id,
    date: normalizeMessageDate(message.date),
    senderId: message.senderId?.toString?.() || null,
    senderLabel: formatSenderLabel(message),
    senderUsername: senderUsername || null,
    senderProfileUrl: senderUsername ? `https://t.me/${senderUsername}` : null,
    text: normalizeText(message.message),
    views: typeof message.views === "number" ? message.views : null,
    forwards: typeof message.forwards === "number" ? message.forwards : null,
    replyToMsgId: message.replyTo?.replyToMsgId || null,
  };
}

export async function listDialogs(client, limit) {
  const dialogs = await client.getDialogs(
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? { limit } : {},
  );

  return dialogs
    .map((dialog) => ({
      title: dialog.title || "(untitled)",
      id: dialog.id?.toString?.() || "",
      unreadCount: dialog.unreadCount || 0,
      approxMessageCount: dialog.message?.id || 0,
      lastMessageDate: normalizeMessageDate(dialog.message?.date),
      entity: dialog.entity,
    }))
    .filter((dialog) => dialog.approxMessageCount > 0)
    .sort((left, right) => left.title.localeCompare(right.title, "ru", { sensitivity: "base" }))
    .map((dialog, index) => ({
      ...dialog,
      index: index + 1,
    }));
}

export async function getExactMessageCount(client, entity) {
  const messages = await client.getMessages(entity, { limit: 1, waitTime: 0 });
  return typeof messages.total === "number" ? messages.total : 0;
}

export function filterDialogsByActivity(dialogs, period) {
  const start = getPeriodStart(period);

  if (!start) {
    return dialogs;
  }

  return dialogs.filter((dialog) => {
    if (!dialog.lastMessageDate) {
      return false;
    }

    return new Date(dialog.lastMessageDate) >= start;
  });
}

export async function fetchMessages(client, entity, limit, period, options = {}) {
  const start = getPeriodStart(period);
  const collected = [];
  let scannedCount = 0;
  let skippedNonTextCount = 0;
  let skippedByCheckpointCount = 0;
  let offsetId = 0;
  const batchSize = 100;
  const minMessageIdExclusive = Number(options.minMessageIdExclusive || 0);

  while (collected.length < limit) {
    const remaining = limit - collected.length;
    const messages = await client.getMessages(entity, {
      limit: Math.min(batchSize, remaining),
      offsetId,
      waitTime: 0,
    });

    if (!messages.length) {
      break;
    }

    let reachedPeriodBoundary = false;
    let reachedCheckpointBoundary = false;

    for (const rawMessage of messages) {
      scannedCount += 1;

      if (minMessageIdExclusive > 0 && Number(rawMessage.id) <= minMessageIdExclusive) {
        reachedCheckpointBoundary = true;
        skippedByCheckpointCount += 1;
        break;
      }

      const formatted = formatMessage(rawMessage);

      if (!formatted.date) {
        continue;
      }

      const messageDate = new Date(formatted.date);

      if (start && messageDate < start) {
        reachedPeriodBoundary = true;
        break;
      }

      if (!formatted.text) {
        skippedNonTextCount += 1;
        continue;
      }

      collected.push(formatted);

      if (collected.length >= limit) {
        break;
      }
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.id || messages.length < Math.min(batchSize, remaining)) {
      break;
    }

    offsetId = lastMessage.id;

    if (reachedPeriodBoundary || reachedCheckpointBoundary) {
      break;
    }
  }

  return {
    messages: collected.sort((a, b) => new Date(a.date) - new Date(b.date)),
    scannedCount,
    skippedNonTextCount,
    skippedByCheckpointCount,
  };
}

export function preprocessMessages(messages) {
  let droppedShortMessages = 0;
  const filtered = messages.filter((message) => {
    if (isTrivialText(message.text)) {
      droppedShortMessages += 1;
      return false;
    }

    return true;
  });

  const merged = [];
  let mergedGroups = 0;
  const mergeWindowMs = DEFAULT_MERGE_WINDOW_MINUTES * 60 * 1000;

  for (const message of filtered) {
    const previous = merged[merged.length - 1];
    const previousDate = previous?.date ? new Date(previous.date).getTime() : null;
    const currentDate = message.date ? new Date(message.date).getTime() : null;

    if (
      previous &&
      previous.senderId &&
      message.senderId &&
      previous.senderId === message.senderId &&
      previousDate !== null &&
      currentDate !== null &&
      currentDate - previousDate <= mergeWindowMs
    ) {
      previous.text = `${previous.text}\n${message.text}`.trim();
      previous.id = message.id;
      previous.date = message.date;
      previous.mergedMessageIds = [...(previous.mergedMessageIds || [previous.id]), message.id];
      mergedGroups += 1;
      continue;
    }

    merged.push({
      ...message,
      mergedMessageIds: [message.id],
    });
  }

  return {
    messages: merged,
    droppedShortMessages,
    mergedGroups,
  };
}
