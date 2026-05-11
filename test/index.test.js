import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";

import { SUMMARY_LANGUAGES } from "../config/summary-languages.js";
import { buildLlmProxyUrl, describeLlmError } from "../src/lib/summarizer.js";
import {
  buildProfileLinkAnalysisUserPrompt,
  buildPromptLanguageVariables,
  callLlm,
  buildStructuredSummary,
  chunkMessages,
  extractProfileLinksFromText,
  formatMessage,
  getTelegramClientOptions,
  getTelegramProxy,
  preprocessMessages,
  resolveOutputFormats,
  resolveRunMode,
  resolveSummaryLanguage,
  saveOutputs,
} from "../src/index.js";

test("resolveSummaryLanguage returns English by default and supports configured languages", () => {
  assert.equal(resolveSummaryLanguage().id, "en");
  assert.equal(resolveSummaryLanguage("en").id, "en");
  assert.equal(resolveSummaryLanguage("Español").id, "es");
  assert.equal(resolveSummaryLanguage("deutsch").id, "de");
  assert.equal(resolveSummaryLanguage("français").id, "fr");
  assert.equal(resolveSummaryLanguage("zh-cn").id, "zh-cn");
  assert.equal(resolveSummaryLanguage("unknown"), undefined);
});

test("buildPromptLanguageVariables includes new useful sections in final heading list", () => {
  const vars = buildPromptLanguageVariables(SUMMARY_LANGUAGES.ru);

  assert.match(vars.finalHeadingList, /## Полезная информация/);
  assert.match(vars.finalHeadingList, /## Полезные ссылки/);
  assert.equal(vars.usefulInfoHeading, "Полезная информация");
  assert.equal(vars.usefulLinksHeading, "Полезные ссылки");
});

test("formatMessage builds senderLabel from sender names, titles and usernames", () => {
  const userMessage = formatMessage({
    id: 1,
    date: 1_700_000_000,
    senderId: { toString: () => "123" },
    sender: {
      firstName: "Ivan",
      lastName: "Petrov",
    },
    message: "Hello",
  });

  const channelMessage = formatMessage({
    id: 2,
    date: 1_700_000_100,
    senderId: { toString: () => "456" },
    sender: {
      title: "News Channel",
    },
    message: "Update",
  });

  const usernameMessage = formatMessage({
    id: 3,
    date: 1_700_000_200,
    senderId: { toString: () => "789" },
    sender: {
      username: "nickname",
    },
    message: "Ping",
  });

  const unknownMessage = formatMessage({
    id: 4,
    date: 1_700_000_300,
    senderId: { toString: () => "999" },
    message: "No sender data",
  });

  assert.equal(userMessage.senderLabel, "Ivan Petrov (123)");
  assert.equal(channelMessage.senderLabel, "News Channel (456)");
  assert.equal(usernameMessage.senderLabel, "@nickname (789)");
  assert.equal(unknownMessage.senderLabel, "Unknown sender (999)");
});

test("preprocessMessages drops trivial texts and merges adjacent messages from the same sender", () => {
  const { messages, droppedShortMessages, mergedGroups } = preprocessMessages([
    {
      id: 1,
      date: "2026-03-22T10:00:00.000Z",
      senderId: "123",
      senderLabel: "Ivan (123)",
      text: "+",
    },
    {
      id: 2,
      date: "2026-03-22T10:01:00.000Z",
      senderId: "123",
      senderLabel: "Ivan (123)",
      text: "First useful message",
    },
    {
      id: 3,
      date: "2026-03-22T10:05:00.000Z",
      senderId: "123",
      senderLabel: "Ivan (123)",
      text: "Second useful message",
    },
    {
      id: 4,
      date: "2026-03-22T10:30:00.000Z",
      senderId: "999",
      senderLabel: "Maria (999)",
      text: "Separate sender",
    },
  ]);

  assert.equal(droppedShortMessages, 1);
  assert.equal(mergedGroups, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "First useful message\nSecond useful message");
  assert.deepEqual(messages[0].mergedMessageIds, [2, 3]);
  assert.equal(messages[1].senderLabel, "Maria (999)");
});

test("chunkMessages uses senderLabel in serialized lines", () => {
  const chunks = chunkMessages([
    {
      id: 1,
      date: "2026-03-22T10:00:00.000Z",
      senderId: "123",
      senderLabel: "Ivan (123)",
      text: "Useful content",
    },
  ], 500);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\] Ivan \(123\): Useful content$/);
});

test("buildLlmProxyUrl uses only LLM proxy settings and does not fall back to Telegram proxy", () => {
  const previous = {
    TELEGRAM_PROXY_HOST: process.env.TELEGRAM_PROXY_HOST,
    TELEGRAM_PROXY_PORT: process.env.TELEGRAM_PROXY_PORT,
    LLM_PROXY_HOST: process.env.LLM_PROXY_HOST,
    LLM_PROXY_PORT: process.env.LLM_PROXY_PORT,
    LLM_PROXY_PROTOCOL: process.env.LLM_PROXY_PROTOCOL,
    LLM_PROXY_USERNAME: process.env.LLM_PROXY_USERNAME,
    LLM_PROXY_PASSWORD: process.env.LLM_PROXY_PASSWORD,
  };

  try {
    process.env.TELEGRAM_PROXY_HOST = "127.0.0.1";
    process.env.TELEGRAM_PROXY_PORT = "9050";
    delete process.env.LLM_PROXY_HOST;
    delete process.env.LLM_PROXY_PORT;
    delete process.env.LLM_PROXY_PROTOCOL;
    delete process.env.LLM_PROXY_USERNAME;
    delete process.env.LLM_PROXY_PASSWORD;

    assert.equal(buildLlmProxyUrl(), undefined);

    process.env.LLM_PROXY_HOST = "10.0.0.5";
    process.env.LLM_PROXY_PORT = "1080";
    process.env.LLM_PROXY_PROTOCOL = "socks5";
    process.env.LLM_PROXY_USERNAME = "alice";
    process.env.LLM_PROXY_PASSWORD = "p@ss word";

    assert.equal(buildLlmProxyUrl(), "socks5://alice:p%40ss%20word@10.0.0.5:1080");

    process.env.LLM_PROXY_PROTOCOL = "http";
    process.env.LLM_PROXY_PORT = "8080";

    assert.equal(buildLlmProxyUrl(), "http://alice:p%40ss%20word@10.0.0.5:8080");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("callLlm supports HTTP proxy settings for LLM requests", async () => {
  const previous = {
    LLM_PROXY_HOST: process.env.LLM_PROXY_HOST,
    LLM_PROXY_PORT: process.env.LLM_PROXY_PORT,
    LLM_PROXY_PROTOCOL: process.env.LLM_PROXY_PROTOCOL,
    LLM_PROXY_USERNAME: process.env.LLM_PROXY_USERNAME,
    LLM_PROXY_PASSWORD: process.env.LLM_PROXY_PASSWORD,
  };

  let proxyAuthorization;
  let targetRequestBody;

  const targetServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      targetRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Proxy works",
              },
            },
          ],
        }),
      );
    });
  });

  const proxyServer = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Expected CONNECT tunneling");
  });

  proxyServer.on("connect", (req, clientSocket, head) => {
    proxyAuthorization = req.headers["proxy-authorization"];
    const [host, portRaw] = String(req.url || "").split(":");
    const upstream = net.connect(Number(portRaw), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const closeSockets = () => {
      upstream.destroy();
      clientSocket.destroy();
    };

    upstream.on("error", closeSockets);
    clientSocket.on("error", closeSockets);
  });

  try {
    await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));

    const targetAddress = targetServer.address();
    const proxyAddress = proxyServer.address();

    process.env.LLM_PROXY_HOST = "127.0.0.1";
    process.env.LLM_PROXY_PORT = String(proxyAddress.port);
    process.env.LLM_PROXY_PROTOCOL = "http";
    process.env.LLM_PROXY_USERNAME = "alice";
    process.env.LLM_PROXY_PASSWORD = "secret";

    const summary = await callLlm(
      {
        id: "test-openai",
        apiType: "openai",
        endpoint: `http://127.0.0.1:${targetAddress.port}/v1/chat/completions`,
        apiKey: "test-key",
      },
      "test-model",
      "system prompt",
      "user prompt",
    );

    assert.equal(summary, "Proxy works");
    assert.equal(
      proxyAuthorization,
      `Basic ${Buffer.from("alice:secret", "utf8").toString("base64")}`,
    );
    assert.equal(targetRequestBody.model, "test-model");
    assert.equal(targetRequestBody.messages[0].content, "system prompt");
    assert.equal(targetRequestBody.messages[1].content, "user prompt");
  } finally {
    await Promise.all([
      new Promise((resolve) => targetServer.close(resolve)),
      new Promise((resolve) => proxyServer.close(resolve)),
    ]);

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("getTelegramProxy supports HTTP proxy settings for Telegram", () => {
  const previous = {
    TELEGRAM_PROXY_PROTOCOL: process.env.TELEGRAM_PROXY_PROTOCOL,
    TELEGRAM_PROXY_HOST: process.env.TELEGRAM_PROXY_HOST,
    TELEGRAM_PROXY_PORT: process.env.TELEGRAM_PROXY_PORT,
    TELEGRAM_PROXY_USERNAME: process.env.TELEGRAM_PROXY_USERNAME,
    TELEGRAM_PROXY_PASSWORD: process.env.TELEGRAM_PROXY_PASSWORD,
    TELEGRAM_PROXY_SOCKS_TYPE: process.env.TELEGRAM_PROXY_SOCKS_TYPE,
  };

  try {
    process.env.TELEGRAM_PROXY_PROTOCOL = "http";
    process.env.TELEGRAM_PROXY_HOST = "127.0.0.1";
    process.env.TELEGRAM_PROXY_PORT = "8080";
    process.env.TELEGRAM_PROXY_USERNAME = "alice";
    process.env.TELEGRAM_PROXY_PASSWORD = "secret";

    assert.deepEqual(getTelegramProxy(), {
      ip: "127.0.0.1",
      port: 8080,
      protocol: "http",
      username: "alice",
      password: "secret",
      timeout: 10,
    });
    assert.equal(getTelegramClientOptions().networkSocket?.name, "HttpProxyPromisedNetSockets");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("getTelegramProxy keeps SOCKS configuration compatible", () => {
  const previous = {
    TELEGRAM_PROXY_PROTOCOL: process.env.TELEGRAM_PROXY_PROTOCOL,
    TELEGRAM_PROXY_HOST: process.env.TELEGRAM_PROXY_HOST,
    TELEGRAM_PROXY_PORT: process.env.TELEGRAM_PROXY_PORT,
    TELEGRAM_PROXY_USERNAME: process.env.TELEGRAM_PROXY_USERNAME,
    TELEGRAM_PROXY_PASSWORD: process.env.TELEGRAM_PROXY_PASSWORD,
    TELEGRAM_PROXY_SOCKS_TYPE: process.env.TELEGRAM_PROXY_SOCKS_TYPE,
  };

  try {
    process.env.TELEGRAM_PROXY_PROTOCOL = "socks5";
    process.env.TELEGRAM_PROXY_HOST = "127.0.0.1";
    process.env.TELEGRAM_PROXY_PORT = "9050";
    process.env.TELEGRAM_PROXY_USERNAME = "bob";
    process.env.TELEGRAM_PROXY_PASSWORD = "pwd";
    process.env.TELEGRAM_PROXY_SOCKS_TYPE = "5";

    assert.deepEqual(getTelegramProxy(), {
      ip: "127.0.0.1",
      port: 9050,
      socksType: 5,
      username: "bob",
      password: "pwd",
    });
    assert.equal(getTelegramClientOptions().networkSocket, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("describeLlmError includes provider, endpoint, proxy mode and nested cause details", () => {
  const rootCause = new Error("other side closed");
  rootCause.code = "UND_ERR_SOCKET";

  const error = new TypeError("fetch failed", { cause: rootCause });
  const message = describeLlmError(error, {
    providerId: "litellm-baza-nomerov",
    modelId: "minimax25",
    endpoint: "https://litellm.baza-nomerov.ru/v1/chat/completions",
    proxyEnabled: true,
    timeoutMs: 120000,
  });

  assert.match(message, /provider=litellm-baza-nomerov/);
  assert.match(message, /model=minimax25/);
  assert.match(message, /endpoint=https:\/\/litellm\.baza-nomerov\.ru\/v1\/chat\/completions/);
  assert.match(message, /proxy=configured/);
  assert.match(message, /cause=UND_ERR_SOCKET/);
  assert.match(message, /detail=other side closed/);
});

test("buildStructuredSummary extracts useful info and useful links sections", () => {
  const language = SUMMARY_LANGUAGES.ru;
  const summary = `# Саммари чата: Test

# Короткая версия
## Главное в 5-10 пунктах
- Пункт 1
## Ключевые решения
- Решение 1
## Срочные action items
- Действие 1
# Полная версия
## Обзор
Краткий обзор
## Люди и роли
- Иван — автор
## Основные темы
- Тема 1
## Договоренности и предложения
- Согласовано одно
## Принятые решения
- Решение принято
## Дедлайны и даты
- 25.03 — дедлайн
## Риски и проблемы
- Риск 1
## Полезная информация
- Лучше запускать incremental mode на длинных чатах
## Полезные ссылки
- https://example.com/docs — документация
## Ссылки из профилей
- @seller — https://seller.example.com — продает консультации
## Action items
- Сделать задачу
## Открытые вопросы
- Вопрос 1
## Кто что обещал
- Иван обещал проверить
## Краткая хронология
- 20.03 — старт
`;

  const structured = buildStructuredSummary(
    { id: "1", title: "Test" },
    [
      {
        id: 1,
        date: "2026-03-22T10:00:00.000Z",
        senderId: "123",
        senderLabel: "Ivan (123)",
        text: "Hello",
      },
    ],
    summary,
    language,
  );

  assert.equal(structured.language, "ru");
  assert.equal(structured.sections.usefulInfo, "- Лучше запускать incremental mode на длинных чатах");
  assert.equal(structured.sections.usefulLinks, "- https://example.com/docs — документация");
  assert.equal(structured.sections.profileLinks, "- @seller — https://seller.example.com — продает консультации");
  assert.deepEqual(structured.parsed.usefulInfo, [
    "Лучше запускать incremental mode на длинных чатах",
  ]);
  assert.deepEqual(structured.parsed.usefulLinks, [
    "https://example.com/docs — документация",
  ]);
  assert.deepEqual(structured.parsed.profileLinks, [
    "@seller — https://seller.example.com — продает консультации",
  ]);
});

test("extractProfileLinksFromText normalizes profile links and telegram handles", () => {
  assert.deepEqual(extractProfileLinksFromText("Bio: example.com, t.me/shop and @seller_bot"), [
    { raw: "example.com", url: "https://example.com" },
    { raw: "t.me/shop", url: "https://t.me/shop" },
    { raw: "@seller_bot", url: "https://t.me/seller_bot" },
  ]);
});

test("buildProfileLinkAnalysisUserPrompt includes profile text, links and author messages", () => {
  const prompt = buildProfileLinkAnalysisUserPrompt(
    [
      {
        senderId: "123",
        displayName: "Seller",
        username: "seller",
        profileUrl: "https://t.me/seller",
        about: "Selling AI subscriptions: https://seller.example.com",
        links: [{ url: "https://seller.example.com" }],
      },
    ],
    [
      {
        id: 1,
        date: "2026-03-22T10:00:00.000Z",
        senderId: "123",
        senderLabel: "Seller (123)",
        text: "I can help set up shared AI accounts.",
      },
    ],
  );

  assert.match(prompt, /Selling AI subscriptions/);
  assert.match(prompt, /https:\/\/seller\.example\.com/);
  assert.match(prompt, /shared AI accounts/);
});

test("resolveRunMode supports the documented aliases", () => {
  assert.equal(resolveRunMode("full"), "full");
  assert.equal(resolveRunMode("inc"), "incremental");
  assert.equal(resolveRunMode("diff"), "changes");
  assert.equal(resolveRunMode("weird"), undefined);
});

test("resolveOutputFormats supports all and comma-separated individual formats", () => {
  assert.deepEqual(resolveOutputFormats(), ["messages", "markdown", "structured", "html"]);
  assert.deepEqual(resolveOutputFormats("html"), ["html"]);
  assert.deepEqual(resolveOutputFormats("md,json"), ["markdown", "structured"]);
  assert.deepEqual(resolveOutputFormats(["messages", "html"]), ["messages", "html"]);
  assert.deepEqual(resolveOutputFormats("all"), ["messages", "markdown", "structured", "html"]);
  assert.equal(resolveOutputFormats("pdf"), undefined);
});

test("saveOutputs writes only the requested output formats", async () => {
  const files = await saveOutputs(
    { id: "dialog-1", title: "Test Output Selection" },
    [
      {
        id: 1,
        date: "2026-03-22T10:00:00.000Z",
        senderId: "123",
        senderLabel: "Ivan (123)",
        text: "Hello",
      },
    ],
    "# Summary\n\n## Highlights\n- Item 1",
    SUMMARY_LANGUAGES.en,
    ["markdown", "html"],
  );

  assert.deepEqual(files.outputFormats, ["markdown", "html"]);
  assert.equal(files.messagesPath, null);
  assert.ok(files.summaryPath);
  assert.equal(files.structuredPath, null);
  assert.ok(files.htmlPath);

  await assert.doesNotReject(() => fs.access(files.summaryPath));
  await assert.doesNotReject(() => fs.access(files.htmlPath));
  await assert.rejects(() => fs.access(files.summaryPath.replace(".summary.md", ".messages.json")));
  await assert.rejects(() => fs.access(files.summaryPath.replace(".summary.md", ".summary.json")));

  await fs.unlink(files.summaryPath);
  await fs.unlink(files.htmlPath);
});
