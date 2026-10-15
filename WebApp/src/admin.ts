import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import PoolSignaling from './pool';
import type AgentHub from './agents';

export function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || provided.length > 4096 || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAdminRouter(token: string, getPool: () => PoolSignaling, getAgents: () => AgentHub = () => undefined): Router {
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
  router.get('/state', (req, res) => {
    const pool = getPool().snapshot(), agents = getAgents();
    res.json({ ...pool, agentsEnabled: !!agents, agents: agents?.snapshot() || [],
      events: [...pool.events, ...(agents?.recentEvents() || [])].sort((a, b) => b.at - a.at).slice(0, 100) });
  });
  router.post('/agents/:agent/instances/:id/:action', async (req, res) => {
    const agents = getAgents();
    if (!agents) { res.status(404).json({ error: 'Process agents are disabled' }); return; }
    const { agent, id, action } = req.params;
    if (!['start', 'stop', 'restart', 'logs'].includes(action)) { res.status(400).json({ error: 'Unknown process action' }); return; }
    if (!agents.owns(agent, id)) { res.status(404).json({ error: 'Unknown managed instance' }); return; }
    const pool = getPool(), wasDraining = pool.isDraining(id);
    try {
      const result = await agents.command(agent, id, action, () => {
        if (action !== 'stop' && action !== 'restart') return;
        pool.setDraining(id, true);
        const current = pool.snapshot().instances.find(s => s.instanceId === id);
        if (current?.connectionId) pool.endSession(current.connectionId);
      });
      if (action === 'start' || (action === 'restart' && !wasDraining)) pool.setDraining(id, false);
      res.json(result);
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
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
