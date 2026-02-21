export function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function requiredString(v, min = 1) {
  return typeof v === 'string' && v.trim().length >= min;
}

export function positiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

export function jsonError(res, status, error, details) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error, details }));
}
