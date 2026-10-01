import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { pool } from '../db';
import redis from '../services/redis';

export interface ApiKeyIdentity {
  keyHash: string;
  maintainerAddress?: string;
  orgId?: string;
}

export type AuthenticatedRequest = Request & { apiKeyIdentity?: ApiKeyIdentity };

const KEY_LIMIT = 120;   // requests per minute for authenticated keys
const IP_LIMIT = 30;     // requests per minute for unauthenticated IPs
const WINDOW_SEC = 60;

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function getIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0] : req.socket.remoteAddress) ?? 'unknown';
}

async function getApiKeyIdentity(raw: string): Promise<ApiKeyIdentity | undefined> {
  const h = hashKey(raw);
  const { rows } = await pool.query(
    'SELECT key_hash, maintainer_address, org_id, revoked_at FROM api_keys WHERE key_hash = $1',
    [h],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.revoked_at) return undefined;
  return {
    keyHash: h,
    maintainerAddress: typeof row.maintainer_address === 'string' ? row.maintainer_address : undefined,
    orgId: typeof row.org_id === 'string' ? row.org_id : undefined,
  };
}

async function checkRedisLimit(
  identifier: string,
  limit: number,
  res: Response,
): Promise<boolean> {
  const key = `rl:${identifier}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SEC);
  if (count > limit) {
    const ttl = await redis.ttl(key);
    res.set('Retry-After', String(ttl > 0 ? ttl : WINDOW_SEC));
    res.status(429).json({ error: 'rate limit exceeded', retryAfter: ttl > 0 ? ttl : WINDOW_SEC });
    return false;
  }
  return true;
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (raw) {
    // Try to validate as API key first
    try {
      const identity = await getApiKeyIdentity(raw);
      if (identity) {
        const allowed = await checkRedisLimit(`key:${hashKey(raw)}`, KEY_LIMIT, res);
        if (allowed) {
          (req as AuthenticatedRequest).apiKeyIdentity = identity;
          return next();
        }
        return;
      }
    } catch {
      // Fall through to IP-based limit if Redis/DB is unavailable
    }
    // Bearer token present but not a valid API key → reject
    res.status(401).json({ error: 'invalid api key' });
    return;
  }

  // No key — apply IP-based fallback rate limit
  const ip = getIp(req);
  try {
    const allowed = await checkRedisLimit(`ip:${ip}`, IP_LIMIT, res);
    if (!allowed) return;
  } catch {
    // If Redis is down, allow through (fail-open)
  }
  next();
}
