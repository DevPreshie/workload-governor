import { SorobanRpc } from '@stellar/stellar-sdk';
import { pool } from './db';
import { logger } from './logger';
import redis, { closeRedis } from './services/redis';

interface ContractEvent {
  type: string;
  ledger: number;
  timestamp: Date;
  actor: string;
  orgId: string;
  issueId?: number;
  contributor?: string;
  data?: Record<string, unknown>;
}

interface EventData {
  type: string;
  xdr: string;
}

interface ContractEventResource {
  type: string;
  id: string;
  pagingToken: string;
  ledger: string;
  createdAt: string;
  topic: EventData[];
  value: EventData[];
}

const CONTRACT_ID =
  process.env.CONTRACT_ID ??
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

/** Redis key used for distributed leader election among indexer replicas. */
const LEADER_LOCK_KEY = 'lock:indexer_leader';

export class EventIndexer {
  private server: SorobanRpc.Server;
  private cursor: string | undefined;
  private isRunning = false;
  /** Resolves when the poll loop has fully exited after stop() is called. */
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;

  constructor() {
    this.server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Set up a promise that resolves once the poll loop has drained.
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });

    logger.info({ message: 'Event indexer started' });

    this.pollForEvents()
      .catch((err) => {
        logger.error({
          message: 'Event indexer error',
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      })
      .finally(() => {
        // Signal that the loop has exited (whether naturally or via error).
        if (this.shutdownResolve) {
          this.shutdownResolve();
        }
      });
  }

  private async pollForEvents(): Promise<void> {
    while (this.isRunning) {
      try {
        const events = await this.server.getEvents({
          filters: [
            {
              type: 'contract',
              contractIds: [CONTRACT_ID],
            },
          ],
          cursor: this.cursor,
        });

        if (events.events.length > 0) {
          for (const event of events.events as unknown[]) {
            try {
              const parsed = this.parseEvent(event as ContractEventResource);
              if (parsed) {
                await this.storeEvent(parsed);
              }
            } catch (err) {
              logger.error({
                message: 'Failed to parse event',
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const lastEvent = events.events[events.events.length - 1] as unknown as ContractEventResource;
          this.cursor = lastEvent.pagingToken;
          logger.info({
            message: 'Ledger batch processed',
            ledger: lastEvent.ledger,
            eventCount: events.events.length,
          });
        }

        // Only sleep if we are still running; a stop() during sleep is fine
        // because the while-condition is re-checked on the next iteration.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (err) {
        logger.error({
          message: 'Event polling error',
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }
  }

  private parseEvent(event: ContractEventResource): ContractEvent | null {
    try {
      const topics = event.topic || [];
      const values = event.value || [];

      if (topics.length === 0) {
        return null;
      }

      const eventType = this.extractEventType(topics);
      if (!eventType) {
        return null;
      }

      const ledger = parseInt(event.ledger, 10);
      const timestamp = new Date(event.createdAt);
      const actor = this.extractActor(values);
      const orgId = this.extractOrgId(values);

      return {
        type: eventType,
        ledger,
        timestamp,
        actor,
        orgId,
        issueId: this.extractIssueId(values),
        contributor: this.extractContributor(values),
        data: {
          topics: topics.map((t: EventData) => t),
          values: values.map((v: EventData) => v),
        },
      };
    } catch {
      return null;
    }
  }

  private extractEventType(topics: EventData[]): string | null {
    if (topics.length === 0) return null;
    const topicXdr = topics[0].xdr;
    if (topicXdr.includes('applied')) return 'applied';
    if (topicXdr.includes('withdrawn')) return 'withdrawn';
    if (topicXdr.includes('assigned')) return 'assigned';
    if (topicXdr.includes('completed')) return 'completed';
    if (topicXdr.includes('revoked')) return 'revoked';
    return null;
  }

  private extractActor(values: EventData[]): string {
    return values.length > 0 ? values[0].xdr.substring(0, 20) : 'unknown';
  }

  private extractOrgId(values: EventData[]): string {
    return values.length > 1 ? values[1].xdr.substring(0, 20) : 'unknown';
  }

  private extractIssueId(values: EventData[]): number | undefined {
    if (values.length > 2) {
      const match = values[2].xdr.match(/\d+/);
      return match ? parseInt(match[0], 10) : undefined;
    }
    return undefined;
  }

  private extractContributor(values: EventData[]): string | undefined {
    return values.length > 3 ? values[3].xdr.substring(0, 20) : undefined;
  }

  private async storeEvent(event: ContractEvent): Promise<void> {
    await pool.query(
      `INSERT INTO contract_events (event_type, ledger_seq, timestamp, actor, org_id, issue_id, contributor, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        event.type,
        event.ledger,
        event.timestamp,
        event.actor,
        event.orgId,
        event.issueId || null,
        event.contributor || null,
        JSON.stringify(event.data),
      ],
    );
  }

  /**
   * Signal the poll loop to stop after the current batch completes, then
   * release the Redis leader lock and close the DB pool so a new replica
   * can acquire the lock without waiting for the TTL to expire.
   */
  async stopGracefully(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info({ message: 'Graceful shutdown initiated — waiting for current batch to finish' });
    this.isRunning = false;

    // Wait for the poll loop to finish processing its current batch.
    if (this.shutdownPromise) {
      await this.shutdownPromise;
    }

    // Explicitly release the distributed leader lock so a new replica can
    // take over immediately without waiting for the TTL to expire.
    try {
      await redis.del(LEADER_LOCK_KEY);
      logger.info({ message: 'Redis leader lock released', key: LEADER_LOCK_KEY });
    } catch (err) {
      logger.error({
        message: 'Failed to release Redis leader lock',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close the Redis connection.
    try {
      await closeRedis();
      logger.info({ message: 'Redis connection closed' });
    } catch (err) {
      logger.error({
        message: 'Error closing Redis connection',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close the Postgres pool.
    try {
      await pool.end();
      logger.info({ message: 'Database pool closed' });
    } catch (err) {
      logger.error({
        message: 'Error closing database pool',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info({ message: 'Event indexer shutdown complete' });
  }

  /** Synchronous stop — does NOT release the Redis lock or drain connections.
   *  Prefer stopGracefully() for production use. */
  stop(): void {
    this.isRunning = false;
    logger.info({ message: 'Event indexer stopped' });
  }
}

let indexer: EventIndexer | null = null;

export function getEventIndexer(): EventIndexer {
  if (!indexer) {
    indexer = new EventIndexer();
  }
  return indexer;
}

export async function startEventIndexer(): Promise<void> {
  const idx = getEventIndexer();
  await idx.start();
}

export function stopEventIndexer(): void {
  if (indexer) {
    indexer.stop();
  }
}

/**
 * Register SIGINT / SIGTERM handlers for graceful shutdown.
 * Call this once from src/index.ts after startEventIndexer().
 */
export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ message: `${signal} received — starting graceful shutdown` });

    const idx = getEventIndexer();
    await idx.stopGracefully();

    process.exit(0);
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error({
        message: 'Error during SIGTERM shutdown',
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error({
        message: 'Error during SIGINT shutdown',
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
  });
}
