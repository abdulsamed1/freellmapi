import { describe, it, expect, beforeAll, vi } from 'vitest';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

function fakeRoute(provider: any) {
  return {
    provider,
    modelId: 'fake-model',
    modelDbId: 9999,
    apiKey: 'k',
    keyId: 1,
    platform: 'fake',
    displayName: 'Fake Model',
    rpdLimit: null,
    tpdLimit: null,
  };
}

async function post(app: Express, path: string, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return {
    status: res.status,
    text,
    contentType: res.headers.get('content-type') ?? '',
    json: () => JSON.parse(text),
  };
}

describe('POST /typesafe/v1/systemone (jevgrep bridge)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('rejects requests without a valid unified key (401)', async () => {
    expect((await post(app, '/typesafe/v1/systemone', { questions: {} })).status).toBe(401);
    expect((await post(app, '/typesafe/v1/systemone', { questions: {} }, 'wrong')).status).toBe(401);
  });

  it('rejects an invalid request body (missing questions) with 400', async () => {
    expect((await post(app, '/typesafe/v1/systemone', { state: 'some state' }, key)).status).toBe(400);
  });

  it('passes synthetic connection check for jg doctor immediately', async () => {
    const res = await post(
      app,
      '/typesafe/v1/systemone',
      {
        state: { source: 'export function recordEvent(event) { events.push(event); }' },
        questions: {
          relevant: {
            type: 'boolean',
            instructions: 'Does this source implement recording an event?',
          },
        },
      },
      key
    );

    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.answers?.relevant?.type).toBe('noul');
    expect(body.answers?.relevant?.noul).toBeGreaterThan(0.5);
  });

  it('evaluates semantic questions using provider and returns noul format', async () => {
    const fakeProvider = {
      chatCompletion: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answers: {
                  q0: { type: 'noul', noul: 0.88 },
                  q1: { type: 'noul', noul: 0.12 },
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 40 },
      }),
    };

    mockRouteRequest.mockReturnValue(fakeRoute(fakeProvider));

    const res = await post(
      app,
      '/typesafe/v1/systemone',
      {
        state: { query: 'authentication middleware', source: 'function auth(req) { ... }' },
        questions: {
          q0: { type: 'noul', instructions: 'Is this related to authentication?' },
          q1: { type: 'noul', instructions: 'Is this database migration?' },
        },
      },
      key
    );

    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.answers.q0.noul).toBe(0.88);
    expect(body.answers.q1.noul).toBe(0.12);
    expect(body.answers.q0.type).toBe('noul');
  });
});
