import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ITER = 120000;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, ITER, 32, 'sha256').toString('hex');
  return `${ITER}:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [iterStr, salt, oldHash] = stored.split(':');
  const iter = Number(iterStr || ITER);
  const fresh = pbkdf2Sync(password, salt, iter, 32, 'sha256').toString('hex');
  return timingSafeEqual(Buffer.from(oldHash, 'hex'), Buffer.from(fresh, 'hex'));
}

export function signToken(payload, secret, expiresSec = 60 * 60 * 12) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresSec };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
