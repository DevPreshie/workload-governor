import { Router, Request, Response } from 'express';
import { getMetrics } from '../services/redis';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  const { hits, misses } = getMetrics();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: { hits, misses },
  });
});

export default router;
