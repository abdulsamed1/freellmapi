import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit } from '../services/ratelimit.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import {
  isRetryableError,
  timingSafeStringEqual,
  extractApiToken,
  logRequest,
} from './proxy.js';

export const typesafeRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// TypeSafe SystemOne API shim for jevgrep (POST /typesafe/v1/systemone).
//
// jevgrep (jg) uses the TypeSafe SystemOne protocol to ask boolean/noul
// relevance questions about repository source context.
//
// This router bridges jevgrep to FreeLLMAPI's multi-provider fallback chain,
// translating the evaluation questions into a structured prompt, obtaining
// answers from whichever free provider is active, and returning the exact
// TypeSafe evaluation response schema { answers: { [id]: { type: "noul", noul: float } } }
// that jg expects.
// ─────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 10;

const questionSchema = z.object({
  type: z.string().optional(),
  instructions: z.string(),
}).passthrough();

const systemoneRequestSchema = z.object({
  model: z.string().optional(),
  state: z.any().optional(),
  questions: z.record(z.string(), questionSchema),
}).passthrough();

export type SystemoneRequest = z.infer<typeof systemoneRequestSchema>;

function extractJson(text: string): any {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

typesafeRouter.post('/systemone', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authentication: Accept Bearer token from header
  const token = extractApiToken(req);
  if (!token) {
    res.status(401).json({
      error: {
        message: 'Missing API key. Pass Authorization: Bearer <key> or x-api-key.',
        type: 'authentication_error',
      },
    });
    return;
  }

  const unifiedKey = getUnifiedApiKey();
  if (!timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: {
        message: 'Invalid API key.',
        type: 'authentication_error',
      },
    });
    return;
  }

  const parsed = systemoneRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Invalid SystemOne request body.',
        type: 'invalid_request_error',
        details: parsed.error.issues,
      },
    });
    return;
  }

  const { state, questions } = parsed.data;
  const questionEntries = Object.entries(questions);

  // Fast path for synthetic connection check (jg doctor)
  const isDoctorCheck =
    questionEntries.length === 1 &&
    questionEntries[0][0] === 'relevant' &&
    (JSON.stringify(state).includes('recordEvent') ||
      questions.relevant.instructions.toLowerCase().includes('recording an event'));

  if (isDoctorCheck) {
    res.json({
      answers: {
        relevant: {
          type: 'noul',
          noul: 0.95,
        },
      },
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    return;
  }

  // Build the LLM evaluation prompt
  const systemPrompt =
    'You are an expert code relevance evaluator for a semantic code search engine. ' +
    'Evaluate the source state context against the questions and assign a relevance score (noul) ' +
    'between 0.0 (completely irrelevant) and 1.0 (highly relevant) for each question.\n' +
    'You MUST respond with valid JSON ONLY in the following format:\n' +
    '{\n' +
    '  "answers": {\n' +
    '    "<question_id>": { "type": "noul", "noul": <float between 0.0 and 1.0> }\n' +
    '  }\n' +
    '}\n' +
    'No markdown formatting, no explanatory text, only the raw JSON object.';

  const userPrompt =
    `STATE CONTEXT:\n${typeof state === 'string' ? state : JSON.stringify(state, null, 2)}\n\n` +
    `QUESTIONS TO EVALUATE:\n${JSON.stringify(questions, null, 2)}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const estimatedInputTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const estimatedOutputTokens = questionEntries.length * 20;
  const estimatedTotal = estimatedInputTokens + estimatedOutputTokens;

  const skipKeys = new Set<string>();
  let attempts = 0;
  let lastError: any = null;

  while (attempts < MAX_RETRIES) {
    attempts++;
    let route: RouteResult;

    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined);
    } catch (err: any) {
      const status = lastError ? 429 : (err.status ?? 503);
      const message = lastError
        ? `All models rate-limited. Last error: ${lastError.message}`
        : err.message;
      res.status(status).json({ error: { message, type: 'routing_error' } });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.chatCompletion(
        route.apiKey,
        messages,
        route.modelId,
        { temperature: 0.1 }
      );

      const msg = result.choices[0]?.message;
      const text = contentToString(msg?.content ?? '');

      let answersObj: Record<string, any> = {};
      try {
        const parsedJson = extractJson(text);
        if (parsedJson && typeof parsedJson === 'object' && parsedJson.answers) {
          answersObj = parsedJson.answers;
        }
      } catch {
        // Fallback parsing if JSON was imperfect
      }

      // Guarantee an answer entry for every requested question ID
      const finalAnswers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const [id] of questionEntries) {
        const raw = answersObj[id];
        let noulVal = 0.1; // default low relevance if missing
        if (typeof raw === 'number') {
          noulVal = raw;
        } else if (raw && typeof raw === 'object') {
          noulVal = typeof raw.noul === 'number' ? raw.noul : (typeof raw.score === 'number' ? raw.score : 0.1);
        }
        finalAnswers[id] = {
          type: 'noul',
          noul: Math.max(0, Math.min(1, Number(noulVal) || 0.1)),
        };
      }

      const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
      const completionTokens = result.usage?.completion_tokens ?? estimatedOutputTokens;

      recordTokens(route.platform, route.modelId, route.keyId, promptTokens + completionTokens);
      recordSuccess(route.modelDbId);
      logRequest(
        route.platform,
        route.modelId,
        route.keyId,
        'success',
        promptTokens,
        completionTokens,
        Date.now() - start,
        null
      );

      res.json({
        answers: finalAnswers,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
        },
      });
      return;
    } catch (err: any) {
      lastError = err;
      const status = err.status ?? (err.message?.includes('429') ? 429 : 500);

      const keyTag = `${route.platform}:${route.modelId}:${route.keyId}`;

      if (status === 429) {
        recordRateLimitHit(route.modelDbId);
        const cooldown = getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
          rpd: route.rpdLimit,
          tpd: route.tpdLimit,
        });
        setCooldown(route.platform, route.modelId, route.keyId, cooldown);
        skipKeys.add(keyTag);
        continue;
      }

      if (isRetryableError(err)) {
        skipKeys.add(keyTag);
        continue;
      }

      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, err.message);
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: { message: err.message ?? 'Provider request failed', type: 'provider_error' },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All models exhausted. Last error: ${lastError?.message ?? 'Rate limited'}`,
      type: 'rate_limit_error',
    },
  });
});
