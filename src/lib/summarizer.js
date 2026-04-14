import http from "node:http";
import https from "node:https";

import { SocksProxyAgent } from "socks-proxy-agent";

import {
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_SUMMARY_CONCURRENCY,
  loadSummaryPrompts,
  readChunkCache,
  renderPrompt,
  requireProviderField,
  sha256,
  sleep,
  writeChunkCache,
} from "./config.js";

export function buildLlmProxyUrl() {
  const host = process.env.LLM_PROXY_HOST?.trim();
  const portRaw = process.env.LLM_PROXY_PORT?.trim();
  const protocol = (process.env.LLM_PROXY_PROTOCOL?.trim() || "socks5").toLowerCase();
  const username = process.env.LLM_PROXY_USERNAME?.trim();
  const password = process.env.LLM_PROXY_PASSWORD?.trim();

  if (!host && !portRaw && !username && !password) {
    return undefined;
  }

  if (!host) {
    throw new Error("LLM_PROXY_HOST must be set when using LLM proxy settings.");
  }

  const port = Number(portRaw || "");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("LLM_PROXY_PORT must be a positive number when LLM_PROXY_HOST is set.");
  }

  if (password && !username) {
    throw new Error("LLM_PROXY_PASSWORD requires LLM_PROXY_USERNAME.");
  }

  if (!["socks", "socks4", "socks4a", "socks5", "socks5h"].includes(protocol)) {
    throw new Error("LLM_PROXY_PROTOCOL must be one of: socks, socks4, socks4a, socks5, socks5h.");
  }

  const credentials = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";

  return `${protocol}://${credentials}${host}:${port}`;
}

function createProxyAgent() {
  const proxyUrl = buildLlmProxyUrl();
  if (!proxyUrl) {
    return undefined;
  }
  return new SocksProxyAgent(proxyUrl);
}

function formatLlmContext({ providerId, modelId, endpoint, proxyEnabled }) {
  return [
    providerId ? `provider=${providerId}` : null,
    modelId ? `model=${modelId}` : null,
    endpoint ? `endpoint=${endpoint}` : null,
    `proxy=${proxyEnabled ? "configured" : "direct"}`,
  ]
    .filter(Boolean)
    .join(", ");
}

export function describeLlmError(error, context = {}) {
  const contextText = formatLlmContext(context);
  const contextSuffix = contextText ? ` (${contextText})` : "";
  const causeCode = error?.cause?.code ? `; cause=${error.cause.code}` : "";
  const causeMessage =
    error?.cause?.message && error.cause.message !== error.message
      ? `; detail=${error.cause.message}`
      : "";

  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    const timeoutMs = Number(context.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      return `LLM request timed out after ${timeoutMs}ms${contextSuffix}.`;
    }

    return `LLM request timed out${contextSuffix}.`;
  }

  if (error?.message === "fetch failed" || error?.code) {
    return `LLM network error${contextSuffix}: request failed${causeCode}${causeMessage}.`;
  }

  const baseMessage = error?.message || String(error);
  return `${baseMessage}${contextSuffix}${causeCode}${causeMessage}.`;
}

async function requestWithLlmDiagnostics(endpoint, options, context) {
  try {
    return await sendJsonRequest(endpoint, options);
  } catch (error) {
    throw new Error(describeLlmError(error, context), { cause: error });
  }
}

async function sendJsonRequest(endpoint, options) {
  const url = new URL(endpoint);
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method || "GET",
      headers: options.headers,
      agent: options.agent,
    });

    const timeoutMs = Number(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      request.setTimeout(timeoutMs, () => {
        request.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), { name: "TimeoutError" }));
      });
    }

    request.on("error", reject);

    request.on("response", (response) => {
      const chunks = [];

      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data;

        if (!raw) {
          data = { _raw: "" };
        } else {
          try {
            data = JSON.parse(raw);
          } catch {
            data = { _raw: raw };
          }
        }

        resolve({
          status: response.statusCode || 0,
          ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
          data,
        });
      });
    });

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

export async function callLlm(provider, modelId, systemPrompt, userPrompt) {
  const retryDelaysMs = [10_000, 30_000, 60_000];
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await callLlmOnce(provider, modelId, systemPrompt, userPrompt);
    } catch (error) {
      lastError = error;

      if (attempt === retryDelaysMs.length) {
        break;
      }

      const delayMs = retryDelaysMs[attempt];
      console.warn(
        `[llm retry ${attempt + 1}/${retryDelaysMs.length}] ${error.message}. Retrying in ${Math.round(
          delayMs / 1000,
        )}s...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function callLlmOnce(provider, modelId, systemPrompt, userPrompt) {
  const endpoint = requireProviderField(provider, "endpoint", provider.endpoint);
  const apiKey = requireProviderField(provider, "apiKey", provider.apiKey);
  const maxOutputTokens = Number.isFinite(DEFAULT_LLM_MAX_OUTPUT_TOKENS) && DEFAULT_LLM_MAX_OUTPUT_TOKENS > 0
    ? DEFAULT_LLM_MAX_OUTPUT_TOKENS
    : 8000;
  const agent = createProxyAgent();
  const requestContext = {
    providerId: provider.id,
    modelId,
    endpoint,
    proxyEnabled: Boolean(agent),
    timeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  };

  if (provider.apiType === "openai") {
    const response = await requestWithLlmDiagnostics(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxOutputTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      timeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, requestContext);

    if (!response.ok) {
      throw new Error(
        `LLM request failed (${response.status}) (${formatLlmContext(requestContext)}): ${JSON.stringify(response.data)}`,
      );
    }

    return extractOpenAIText(response.data, maxOutputTokens);
  }

  if (provider.apiType === "anthropic") {
    const anthropicVersion = provider.anthropicVersion || "2023-06-01";
    const response = await requestWithLlmDiagnostics(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxOutputTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      timeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, requestContext);

    if (!response.ok) {
      throw new Error(
        `LLM request failed (${response.status}) (${formatLlmContext(requestContext)}): ${JSON.stringify(response.data)}`,
      );
    }

    return extractAnthropicText(response.data, maxOutputTokens);
  }

  throw new Error(`Unsupported LLM API type: ${provider.apiType}`);
}

function extractOpenAIText(data, maxOutputTokens) {
  const finishReason = data?.choices?.[0]?.finish_reason;
  const content = data?.choices?.[0]?.message?.content;

  const normalizedContent = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .join("\n")
          .trim()
      : null;

  if (typeof normalizedContent === "string") {
    if (finishReason === "length" || finishReason === "max_tokens") {
      throw new Error(
        `LLM response was truncated by the provider output limit (finish_reason=${finishReason}, max_tokens=${maxOutputTokens}). Increase LLM_MAX_OUTPUT_TOKENS.`,
      );
    }

    return normalizedContent;
  }

  throw new Error(`Unexpected OpenAI-compatible response: ${JSON.stringify(data)}`);
}

function extractAnthropicText(data, maxOutputTokens) {
  const stopReason = data?.stop_reason;
  const content = data?.content;

  if (!Array.isArray(content)) {
    throw new Error(`Unexpected Anthropic-compatible response: ${JSON.stringify(data)}`);
  }

  const text = content
    .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("\n")
    .trim();

  if (stopReason === "max_tokens") {
    throw new Error(
      `LLM response was truncated by the provider output limit (stop_reason=${stopReason}, max_tokens=${maxOutputTokens}). Increase LLM_MAX_OUTPUT_TOKENS.`,
    );
  }

  return text;
}

export function buildPromptLanguageVariables(language) {
  const headings = language.headings;

  return {
    languageNameEnglish: language.label,
    chunkSectionList: language.chunkSections.join(", "),
    finalHeadingList: [
      `# ${headings.shortVersion}`,
      `## ${headings.highlights}`,
      `## ${headings.keyDecisions}`,
      `## ${headings.urgentActions}`,
      `# ${headings.fullVersion}`,
      `## ${headings.overview}`,
      `## ${headings.people}`,
      `## ${headings.topics}`,
      `## ${headings.agreements}`,
      `## ${headings.decisions}`,
      `## ${headings.deadlines}`,
      `## ${headings.risks}`,
      `## ${headings.usefulInfo}`,
      `## ${headings.usefulLinks}`,
      `## ${headings.actions}`,
      `## ${headings.openQuestions}`,
      `## ${headings.promises}`,
      `## ${headings.chronology}`,
    ].join(", "),
    highlightsHeading: headings.highlights,
    peopleHeading: headings.people,
    topicsHeading: headings.topics,
    agreementsHeading: headings.agreements,
    keyDecisionsHeading: headings.keyDecisions,
    decisionsHeading: headings.decisions,
    deadlinesHeading: headings.deadlines,
    usefulInfoHeading: headings.usefulInfo,
    usefulLinksHeading: headings.usefulLinks,
    actionsHeading: headings.actions,
  };
}

export function chunkMessages(messages, maxChars = 12000) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const message of messages) {
    const line = `[${message.date}] ${message.senderLabel || message.senderId || "unknown"}: ${message.text}`;
    const lineLength = line.length + 1;

    if (current.length > 0 && currentLength + lineLength > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += lineLength;
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

function formatPercent(current, total) {
  if (!total) {
    return "0%";
  }

  return `${Math.round((current / total) * 100)}%`;
}

export function resolveSummaryConcurrency(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }

  return Math.max(1, Math.floor(parsed));
}

async function summarizeChunk(provider, modelId, prompts, language, chunk, chunkIndex, totalChunks) {
  const languageVariables = buildPromptLanguageVariables(language);
  const systemPrompt = renderPrompt(prompts.chunkSystem, languageVariables);
  const userPrompt = renderPrompt(prompts.chunkUser, { chunkIndex, totalChunks, chunk });
  const cacheKey = sha256(
    JSON.stringify({
      providerId: provider.id,
      model: modelId,
      language: language.id,
      chunkSystem: systemPrompt,
      chunkUser: userPrompt,
    }),
  );

  const cached = await readChunkCache(cacheKey);
  if (cached) {
    return { summary: cached, cacheHit: true };
  }

  const summary = await callLlm(provider, modelId, systemPrompt, userPrompt);
  await writeChunkCache(cacheKey, {
    providerId: provider.id,
    model: modelId,
    language: language.id,
    chunkIndex,
    totalChunks,
    summary,
    cachedAt: new Date().toISOString(),
  });

  return { summary, cacheHit: false };
}

export async function summarizeMessages(messages, dialogTitle, llmSelection, language) {
  const prompts = await loadSummaryPrompts();
  const chunks = chunkMessages(messages);
  const concurrency = resolveSummaryConcurrency(process.env.SUMMARY_CONCURRENCY || DEFAULT_SUMMARY_CONCURRENCY);
  const { provider, modelId } = llmSelection;

  if (chunks.length === 0) {
    return "No text messages found for summarization.";
  }

  console.log(
    `Preparing ${chunks.length} chunk(s) for summarization with concurrency=${Math.min(
      concurrency,
      chunks.length,
    )}...`,
  );
  const partials = new Array(chunks.length);
  let completed = 0;
  let nextIndex = 0;
  let cacheHits = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= chunks.length) {
        return;
      }

      const chunkNumber = index + 1;
      console.log(`[summary queued] Chunk ${chunkNumber}/${chunks.length} started...`);
      const { summary, cacheHit } = await summarizeChunk(
        provider,
        modelId,
        prompts,
        language,
        chunks[index],
        chunkNumber,
        chunks.length,
      );
      if (cacheHit) {
        cacheHits += 1;
      }
      partials[index] = `Chunk ${chunkNumber}\n${summary}`;
      completed += 1;
      console.log(
        `[summary ${formatPercent(completed, chunks.length)}] Chunk ${chunkNumber}/${chunks.length} finished${cacheHit ? " (cache)" : ""}.`,
      );
    }
  }

  const workerCount = Math.min(resolveSummaryConcurrency(concurrency), chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (cacheHits > 0) {
    console.log(`Reused ${cacheHits} cached chunk summaries.`);
  }

  const combined = partials.join("\n\n");
  console.log(`[summary 100%] Building final ${language.logLabel} summary...`);
  const languageVariables = buildPromptLanguageVariables(language);
  const summary = await callLlm(
    provider,
    modelId,
    renderPrompt(prompts.finalSystem, languageVariables),
    renderPrompt(prompts.finalUser, { dialogTitle, combined }),
  );

  return `# ${language.reportTitle}: ${dialogTitle}\n\n${summary}`.trim();
}
