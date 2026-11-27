import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createE2EApp, E2EApp } from '../support';

let ctx: E2EApp;

beforeAll(async () => {
  ctx = await createE2EApp();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await ctx?.close();
});

it('exchanges only an active Anchor session for a short-lived Convex token', async () => {
  const user = await ctx.registerUser();
  const endpoint = '/api/auth/convex-token';
  const issuer = 'https://anchor-e2e.invalid';
  const convexUrl = process.env.ANCHOR_E2E_CONVEX_URL;
  const privateKey = convexUrl
    ? readFileSync(process.env.ANCHOR_E2E_CONVEX_KEY_FILE ?? '', 'utf8')
    : generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString();
  await user.http.post(endpoint).expect(503);
  vi.stubEnv('ANCHOR_AUTH_ISSUER', issuer);
  vi.stubEnv('ANCHOR_CONVEX_SIGNING_KEY', privateKey);

  await request(ctx.http).post(endpoint).expect(401);
  const response = await user.http.post(endpoint).expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const { token } = response.body as { token: string };
  const [header, claims, signature] = token.split('.');
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject(
    {
      alg: 'RS256',
      kid: 'anchor-convex',
    },
  );
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString()) as {
    sub: string;
    iss: string;
    aud: string;
    iat: number;
    exp: number;
  };
  expect(payload).toMatchObject({ sub: user.id, iss: issuer, aud: 'anchor' });
  expect(payload.exp - payload.iat).toBe(60);
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      createPublicKey(privateKey),
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true);

  if (convexUrl) {
    const id = randomUUID();
    const result = await fetch(new URL('/api/mutation', convexUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'notes:create',
        args: { id, title: 'Created using an Anchor session' },
        format: 'json',
      }),
    });
    expect(await result.json()).toMatchObject({
      status: 'success',
      value: { id, permission: 'owner', version: 1 },
    });
  }

  await ctx.prisma.user.update({
    where: { id: user.id },
    data: { sessionsRevokedAt: new Date(Date.now() + 1000) },
  });
  await user.http.post(endpoint).expect(401);
});
