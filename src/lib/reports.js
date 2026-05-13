import fs from "node:fs/promises";
import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import path from "node:path";

import { OUTPUT_DIR, OUTPUT_FORMATS, ensureDir } from "./config.js";

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(markdownItAnchor, {
  slugify: (value) => slugifyHeading(value),
  permalink: false,
});

function makeSafeName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 80);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugifyHeading(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function collectHeadings(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.match(/^(##?)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      level: match[1].length,
      title: match[2].trim(),
      anchor: slugifyHeading(match[2].trim()),
    }));
}

function buildTableOfContents(markdown, language) {
  const headings = collectHeadings(markdown).filter((heading) => heading.level <= 2);

  if (!headings.length) {
    return "";
  }

  const lines = [`## ${language.tocHeading}`, ""];
  for (const heading of headings) {
    lines.push(`- [${heading.title}](#${heading.anchor})`);
  }

  return `${lines.join("\n")}\n\n`;
}

function buildStats(messages) {
  const firstDate = messages[0]?.date || null;
  const lastDate = messages[messages.length - 1]?.date || null;
  const uniqueSenders = new Set(messages.map((message) => message.senderId).filter(Boolean)).size;

  return {
    textMessages: messages.length,
    uniqueSenders,
    firstDate,
    lastDate,
  };
}

export function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|^#\\s+|\\Z)`, "m"));
  return match ? match[1].trim() : "";
}

export function extractBulletItems(sectionText) {
  return sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function buildMarkdownReport(dialog, messages, summary, language, extraMarkdown = "") {
  const stats = buildStats(messages);
  const body = [summary.trim(), String(extraMarkdown || "").trim()].filter(Boolean).join("\n\n");
  const statsBlock = [
    `## ${language.statsHeading}`,
    "",
    `- ${language.statsDialog}: ${dialog.title}`,
    `- ${language.statsTextMessages}: ${stats.textMessages}`,
    `- ${language.statsUniqueSenders}: ${stats.uniqueSenders}`,
    `- ${language.statsFirstDate}: ${stats.firstDate || "unknown"}`,
    `- ${language.statsLastDate}: ${stats.lastDate || "unknown"}`,
    "",
  ].join("\n");

  const toc = buildTableOfContents(body, language);
  return `${statsBlock}${toc}${body}`.trim();
}

export function buildStructuredSummary(dialog, messages, summary, language, extraData = {}) {
  const headings = language.headings;
  const highlights = extractSection(summary, headings.highlights);
  const people = extractSection(summary, headings.people);
  const topics = extractSection(summary, headings.topics);
  const keyDecisions = extractSection(summary, headings.keyDecisions);
  const decisions = extractSection(summary, headings.decisions);
  const deadlines = extractSection(summary, headings.deadlines);
  const risks = extractSection(summary, headings.risks);
  const usefulInfo = extractSection(summary, headings.usefulInfo);
  const usefulLinks = extractSection(summary, headings.usefulLinks);
  const profileLinks = headings.profileLinks ? extractSection(summary, headings.profileLinks) : "";
  const actions = extractSection(summary, headings.actions);
  const urgentActions = extractSection(summary, headings.urgentActions);
  const openQuestions = extractSection(summary, headings.openQuestions);
  const promises = extractSection(summary, headings.promises);

  return {
    dialog: {
      title: dialog.title,
      id: dialog.id,
    },
    language: language.id,
    stats: buildStats(messages),
    generatedAt: new Date().toISOString(),
    summaryMarkdown: summary,
    sections: {
      highlights,
      people,
      topics,
      keyDecisions,
      decisions,
      deadlines,
      risks,
      usefulInfo,
      usefulLinks,
      profileLinks,
      actions,
      urgentActions,
      openQuestions,
      promises,
    },
    parsed: {
      highlights: extractBulletItems(highlights),
      people: extractBulletItems(people),
      keyDecisions: extractBulletItems(keyDecisions),
      decisions: extractBulletItems(decisions),
      deadlines: extractBulletItems(deadlines),
      usefulInfo: extractBulletItems(usefulInfo),
      usefulLinks: extractBulletItems(usefulLinks),
      profileLinks: extractBulletItems(profileLinks),
      actions: extractBulletItems(actions),
      urgentActions: extractBulletItems(urgentActions),
      openQuestions: extractBulletItems(openQuestions),
      promises: extractBulletItems(promises),
    },
    profileLinks: extraData.profileLinks || [],
    messages,
  };
}

function markdownToHtml(markdown) {
  return markdownRenderer
    .render(markdown)
    .replace(/<a href="(https?:\/\/[^"]+)">/g, '<a href="$1" target="_blank" rel="noreferrer noopener">')
    .replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, (segment) => {
      if (!segment.startsWith("<code>")) {
        return segment;
      }

      const content = segment.slice("<code>".length, -"</code>".length);
      const protocolMatches = [...content.matchAll(/https?:\/\/[^\s<]+/g)].map((match) => ({
        index: match.index,
        lastIndex: match.index + match[0].length,
        url: match[0],
      }));
      const matches = protocolMatches.length ? protocolMatches : markdownRenderer.linkify.match(content);

      if (!matches?.length) {
        return segment;
      }

      let cursor = 0;
      let linkedContent = "";

      for (const match of matches) {
        linkedContent += content.slice(cursor, match.index);
        linkedContent += `<a href="${match.url}" target="_blank" rel="noreferrer noopener">${content.slice(match.index, match.lastIndex)}</a>`;
        cursor = match.lastIndex;
      }

      linkedContent += content.slice(cursor);
      return `<code>${linkedContent}</code>`;
    });
}

function buildHtmlReport(dialog, messages, markdownReport, language) {
  const stats = buildStats(messages);
  const body = markdownToHtml(markdownReport);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(dialog.title)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Georgia, "Times New Roman", serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1f2328; background: #f8f6f1; }
    h1, h2 { line-height: 1.2; }
    h1 { margin-top: 32px; }
    h2 { margin-top: 28px; }
    p, li, td, th { font-size: 16px; line-height: 1.6; }
    .meta { padding: 16px 18px; background: #fffdf7; border: 1px solid #e8dfcc; border-radius: 12px; margin-bottom: 24px; }
    .report { background: #fffdf9; border: 1px solid #eadfca; border-radius: 16px; padding: 28px; overflow-x: auto; }
    code { background: #efe7d6; padding: 2px 6px; border-radius: 6px; }
    pre { background: #f4ead7; padding: 16px; border-radius: 12px; overflow-x: auto; }
    pre code { background: transparent; padding: 0; }
    ul { padding-left: 22px; }
    a { color: #7b4b16; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; background: #fff; }
    th, td { border: 1px solid #e6dac4; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #f1e7d4; font-weight: 700; }
    tbody tr:nth-child(even) { background: #fbf7ef; }
    blockquote { margin: 16px 0; padding: 8px 16px; border-left: 4px solid #d4b483; background: #fcf8f0; }
    hr { border: 0; border-top: 1px solid #e6dac4; margin: 28px 0; }
  </style>
</head>
<body>
  <div class="meta">
    <strong>${escapeHtml(dialog.title)}</strong><br>
    ${escapeHtml(language.htmlMessagesCount)}: ${stats.textMessages}<br>
    ${escapeHtml(language.htmlUniqueSenders)}: ${stats.uniqueSenders}<br>
    ${escapeHtml(language.htmlPeriod)}: ${escapeHtml(stats.firstDate || "unknown")} - ${escapeHtml(stats.lastDate || "unknown")}
  </div>
  <div class="report">
    ${body}
  </div>
</body>
</html>`;
}

export async function saveOutputs(
  dialog,
  messages,
  summary,
  language,
  outputFormats = OUTPUT_FORMATS,
  extraData = {},
) {
  await ensureDir(OUTPUT_DIR);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${timestamp}_${makeSafeName(dialog.title || "dialog")}`;
  const messagesPath = path.join(OUTPUT_DIR, `${prefix}.messages.json`);
  const summaryPath = path.join(OUTPUT_DIR, `${prefix}.summary.md`);
  const htmlPath = path.join(OUTPUT_DIR, `${prefix}.summary.html`);
  const structuredPath = path.join(OUTPUT_DIR, `${prefix}.summary.json`);
  const markdownReport = buildMarkdownReport(dialog, messages, summary, language, extraData.extraMarkdown);
  const structuredSummary = buildStructuredSummary(dialog, messages, markdownReport, language, extraData);
  const htmlReport = buildHtmlReport(dialog, messages, markdownReport, language);
  const selectedFormats = new Set(outputFormats);

  if (selectedFormats.has("messages")) {
    await fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), "utf8");
  }
  if (selectedFormats.has("markdown")) {
    await fs.writeFile(summaryPath, markdownReport, "utf8");
  }
  if (selectedFormats.has("structured")) {
    await fs.writeFile(structuredPath, JSON.stringify(structuredSummary, null, 2), "utf8");
  }
  if (selectedFormats.has("html")) {
    await fs.writeFile(htmlPath, htmlReport, "utf8");
  }

  return {
    outputFormats: [...selectedFormats],
    messagesPath: selectedFormats.has("messages") ? messagesPath : null,
    summaryPath: selectedFormats.has("markdown") ? summaryPath : null,
    structuredPath: selectedFormats.has("structured") ? structuredPath : null,
    htmlPath: selectedFormats.has("html") ? htmlPath : null,
  };
}
