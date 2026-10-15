import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import PoolSignaling from './pool';

export function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || provided.length > 4096 || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAdminRouter(token: string, getPool: () => PoolSignaling): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const credential = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
    if (!tokenMatches(credential, token)) {
      res.status(401).json({ error: 'Invalid management credential' }); return;
    }
    if (req.method !== 'GET' && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
      } catch (_) { res.status(403).json({ error: 'Cross-origin management requests are not allowed' }); return; }
    }
    if (!getPool()) { res.status(503).json({ error: 'Instance pool is not ready' }); return; }
    next();
  });
  router.get('/state', (req, res) => res.json(getPool().snapshot()));
  router.post('/instances/:id/:action', (req, res) => {
    if (!['drain', 'resume', 'reset'].includes(req.params.action)) {
      res.status(400).json({ error: 'Unknown instance action' }); return;
    }
    if (!getPool().manageInstance(req.params.id, req.params.action)) {
      res.status(404).json({ error: 'Instance is offline or no longer exists' }); return;
    }
    res.json({ ok: true });
  });
  router.post('/sessions/:id/end', (req, res) => {
    if (!getPool().endSession(req.params.id)) {
      res.status(404).json({ error: 'Session has already ended' }); return;
    }
    res.json({ ok: true });
  });
  return router;
}
