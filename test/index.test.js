import test from "node:test";
import assert from "node:assert/strict";

import { SUMMARY_LANGUAGES } from "../config/summary-languages.js";
import {
  buildPromptLanguageVariables,
  buildStructuredSummary,
  chunkMessages,
  formatMessage,
  preprocessMessages,
  resolveRunMode,
  resolveSummaryLanguage,
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
  assert.deepEqual(structured.parsed.usefulInfo, [
    "Лучше запускать incremental mode на длинных чатах",
  ]);
  assert.deepEqual(structured.parsed.usefulLinks, [
    "https://example.com/docs — документация",
  ]);
});

test("resolveRunMode supports the documented aliases", () => {
  assert.equal(resolveRunMode("full"), "full");
  assert.equal(resolveRunMode("inc"), "incremental");
  assert.equal(resolveRunMode("diff"), "changes");
  assert.equal(resolveRunMode("weird"), undefined);
});
