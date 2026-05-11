import fs from "node:fs/promises";

import { Api } from "telegram";

import {
  DEFAULT_PROFILE_CACHE_TTL_DAYS,
  DEFAULT_PROFILE_LINK_AUTHOR_CHAR_LIMIT,
  DEFAULT_PROFILE_LINK_AUTHOR_MESSAGE_LIMIT,
  PROFILE_CACHE_DIR,
  PROFILE_CACHE_FILE,
  ensureDir,
} from "./config.js";
import { callLlm } from "./summarizer.js";
import { normalizeText } from "./telegram.js";

const PROFILE_LINK_PATTERN =
  /https?:\/\/[^\s<>()"'`]+|(?:t\.me|telegram\.me)\/[A-Za-z0-9_/?=&%#.-]+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s<>()"'`]+)?|@[A-Za-z0-9_]{5,32}/giu;

function stripTrailingPunctuation(value) {
  return String(value).replace(/[.,;:!?)]*$/u, "");
}

function normalizeProfileLink(rawValue) {
  const raw = stripTrailingPunctuation(rawValue).trim();

  if (!raw) {
    return null;
  }

  if (raw.startsWith("@")) {
    return `https://t.me/${raw.slice(1)}`;
  }

  if (/^https?:\/\//iu.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

export function extractProfileLinksFromText(text) {
  const source = String(text || "");
  const links = [];
  const seen = new Set();

  for (const match of source.matchAll(PROFILE_LINK_PATTERN)) {
    const raw = match[0];
    if (raw.includes("@") && !raw.startsWith("@")) {
      continue;
    }

    const url = normalizeProfileLink(raw);
    const key = url?.toLowerCase();
    if (!url || seen.has(key)) {
      continue;
    }

    seen.add(key);
    links.push({
      raw,
      url,
    });
  }

  return links;
}

async function loadProfileCache() {
  try {
    const raw = await fs.readFile(PROFILE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
  } catch {
    return {};
  }
}

async function saveProfileCache(profiles) {
  await ensureDir(PROFILE_CACHE_DIR);
  await fs.writeFile(
    PROFILE_CACHE_FILE,
    JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      profiles,
    }, null, 2),
    "utf8",
  );
}

function isCacheFresh(profile, now = new Date()) {
  const ttlDays = Number(DEFAULT_PROFILE_CACHE_TTL_DAYS);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || !profile?.fetchedAt) {
    return false;
  }

  const fetchedAt = new Date(profile.fetchedAt).getTime();
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }

  return now.getTime() - fetchedAt <= ttlDays * 24 * 60 * 60 * 1000;
}

function stringifyTelegramId(value) {
  return value?.toString?.() || String(value || "");
}

function getEntityKind(entity) {
  if (entity instanceof Api.User) {
    return "user";
  }
  if (entity instanceof Api.Channel) {
    return entity.broadcast ? "channel" : "group";
  }
  if (entity instanceof Api.Chat) {
    return "chat";
  }
  return "unknown";
}

function collectEntityUsernames(entity) {
  const usernames = [];

  if (typeof entity?.username === "string" && entity.username.trim()) {
    usernames.push(entity.username.trim());
  }

  if (Array.isArray(entity?.usernames)) {
    for (const username of entity.usernames) {
      if (username?.active && typeof username.username === "string" && username.username.trim()) {
        usernames.push(username.username.trim());
      }
    }
  }

  return [...new Set(usernames)];
}

function formatEntityDisplayName(entity, fallbackLabel) {
  if (typeof entity?.title === "string" && entity.title.trim()) {
    return entity.title.trim();
  }

  const firstName = typeof entity?.firstName === "string" ? entity.firstName.trim() : "";
  const lastName = typeof entity?.lastName === "string" ? entity.lastName.trim() : "";
  const fullName = `${firstName} ${lastName}`.trim();

  if (fullName) {
    return fullName;
  }

  const username = collectEntityUsernames(entity)[0];
  if (username) {
    return `@${username}`;
  }

  return fallbackLabel || "unknown";
}

async function resolveSenderEntity(client, sender) {
  const refs = [sender.senderUsername, sender.senderId].filter(Boolean);
  let lastError;

  for (const ref of [...new Set(refs)]) {
    try {
      return await client.getEntity(ref);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Could not resolve sender entity ${sender.senderId || "(unknown)"}.`);
}

async function fetchFullProfile(client, sender) {
  const entity = await resolveSenderEntity(client, sender);
  const kind = getEntityKind(entity);
  let full = null;
  let fullEntity = entity;

  if (entity instanceof Api.User) {
    const result = await client.invoke(new Api.users.GetFullUser({ id: entity }));
    full = result.fullUser;
    fullEntity = result.users?.find((item) => stringifyTelegramId(item.id) === stringifyTelegramId(entity.id)) || entity;
  } else if (entity instanceof Api.Channel) {
    const result = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    full = result.fullChat;
    fullEntity = result.chats?.find((item) => stringifyTelegramId(item.id) === stringifyTelegramId(entity.id)) || entity;
  } else if (entity instanceof Api.Chat) {
    const result = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
    full = result.fullChat;
    fullEntity = result.chats?.find((item) => stringifyTelegramId(item.id) === stringifyTelegramId(entity.id)) || entity;
  }

  const usernames = collectEntityUsernames(fullEntity);
  const about = normalizeText(full?.about || "");
  const primaryUsername = usernames[0] || sender.senderUsername || "";

  return {
    senderId: sender.senderId,
    kind,
    displayName: formatEntityDisplayName(fullEntity, sender.senderLabel),
    username: primaryUsername || null,
    usernames,
    profileUrl: primaryUsername ? `https://t.me/${primaryUsername}` : null,
    about,
    links: extractProfileLinksFromText(about),
    fetchedAt: new Date().toISOString(),
  };
}

function collectUniqueSenders(messages) {
  const senders = new Map();

  for (const message of messages) {
    if (!message.senderId || senders.has(message.senderId)) {
      continue;
    }

    senders.set(message.senderId, {
      senderId: message.senderId,
      senderLabel: message.senderLabel || message.senderId,
      senderUsername: message.senderUsername || null,
    });
  }

  return [...senders.values()];
}

export async function collectProfileLinks(client, messages) {
  const senders = collectUniqueSenders(messages);
  const cache = await loadProfileCache();
  const profiles = [];
  let cacheHits = 0;
  let fetchedCount = 0;
  let failedCount = 0;
  let cacheChanged = false;

  for (const sender of senders) {
    const cached = cache[sender.senderId];
    if (isCacheFresh(cached)) {
      cacheHits += 1;
      profiles.push({ ...cached, cacheHit: true });
      continue;
    }

    try {
      const profile = await fetchFullProfile(client, sender);
      fetchedCount += 1;
      cache[sender.senderId] = profile;
      profiles.push({ ...profile, cacheHit: false });
      cacheChanged = true;
    } catch (error) {
      failedCount += 1;
      const failedProfile = {
        senderId: sender.senderId,
        displayName: sender.senderLabel || sender.senderId,
        username: sender.senderUsername || null,
        profileUrl: sender.senderUsername ? `https://t.me/${sender.senderUsername}` : null,
        about: "",
        links: [],
        error: error?.message || String(error),
        fetchedAt: new Date().toISOString(),
      };
      profiles.push({ ...failedProfile, cacheHit: false });
    }
  }

  if (cacheChanged) {
    await saveProfileCache(cache);
  }

  const profilesWithLinks = profiles.filter((profile) => Array.isArray(profile.links) && profile.links.length > 0);
  const linkCount = profilesWithLinks.reduce((total, profile) => total + profile.links.length, 0);

  return {
    profiles,
    profilesWithLinks,
    checkedCount: senders.length,
    cacheHits,
    fetchedCount,
    failedCount,
    linkCount,
  };
}

function capText(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 20)).trim()}... [truncated]`;
}

function collectAuthorMessageSample(messages, senderId, options = {}) {
  const messageLimit = Number(options.messageLimit || DEFAULT_PROFILE_LINK_AUTHOR_MESSAGE_LIMIT);
  const charLimit = Number(options.charLimit || DEFAULT_PROFILE_LINK_AUTHOR_CHAR_LIMIT);
  const selected = messages
    .filter((message) => message.senderId === senderId && message.text)
    .slice(-Math.max(1, Number.isFinite(messageLimit) ? messageLimit : 25));
  const lines = selected.map((message) => `- [${message.date || "unknown date"}] ${message.text}`);

  return capText(lines.join("\n"), Number.isFinite(charLimit) && charLimit > 0 ? charLimit : 6000);
}

export function buildProfileLinkAnalysisUserPrompt(profilesWithLinks, messages, options = {}) {
  const blocks = profilesWithLinks.map((profile, index) => {
    const links = profile.links.map((link) => `- ${link.url}`).join("\n");
    const messagesSample = collectAuthorMessageSample(messages, profile.senderId, options) || "- No text messages.";

    return [
      `Author ${index + 1}`,
      `Name: ${profile.displayName || profile.senderId}`,
      `Sender id: ${profile.senderId}`,
      `Username: ${profile.username ? `@${profile.username}` : "unknown"}`,
      `Profile URL: ${profile.profileUrl || "unknown"}`,
      `Profile text: ${profile.about || "(empty)"}`,
      "Links found in profile text:",
      links,
      "Messages by this author:",
      messagesSample,
    ].join("\n");
  });

  return `Analyze these Telegram profile links and the author's messages:\n\n${blocks.join("\n\n---\n\n")}`;
}

function profileLinksHeading(language) {
  return language.headings?.profileLinks || "Profile links";
}

function stripLeadingMarkdownHeading(markdown) {
  return String(markdown || "")
    .trim()
    .replace(/^#{1,3}\s+.+\n+/u, "")
    .trim();
}

export function buildProfileLinksMarkdown(analysisMarkdown, language) {
  const body = stripLeadingMarkdownHeading(analysisMarkdown);
  if (!body) {
    return "";
  }

  return `## ${profileLinksHeading(language)}\n\n${body}`;
}

export async function summarizeProfileLinks(profilesWithLinks, messages, llmSelection, language, options = {}) {
  if (!profilesWithLinks.length) {
    return "";
  }

  const systemPrompt = [
    `You analyze Telegram profile links in ${language.label}.`,
    "For every provided profile link, infer what the profile owner sells, offers, promotes, or represents.",
    "Use only the profile text and the author's messages included in the prompt.",
    "If there is not enough evidence, say that it is unclear instead of guessing.",
    "Return markdown bullet points only, one bullet per link.",
    "Each bullet must include the owner, the link, what they sell/offer, and the evidence source.",
  ].join(" ");
  const userPrompt = buildProfileLinkAnalysisUserPrompt(profilesWithLinks, messages, options);
  const analysis = await callLlm(llmSelection.provider, llmSelection.modelId, systemPrompt, userPrompt);

  return buildProfileLinksMarkdown(analysis, language);
}
