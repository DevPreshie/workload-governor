import https from "https";
import http from "http";
import { HorizonError } from "./HorizonError";

export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: Array<{ balance: string; asset_type: string }>;
}

const DEFAULT_BASE_URL = "https://horizon-testnet.stellar.org";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

/** Number of consecutive 5xx/429 errors before opening the circuit */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** How long (ms) to wait before probing a tripped endpoint */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/* istanbul ignore next -- transport helpers */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    (url.startsWith("https") ? https : http)
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}

/* istanbul ignore next -- transport helpers */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Circuit state for a single endpoint */
export type CircuitState = "closed" | "open" | "half-open";

export interface EndpointHealth {
  url: string;
  state: CircuitState;
  failures: number;
  nextProbeAt: number;
}

/**
 * Manages circuit-breaker state for a pool of RPC endpoints.
 * Exported so tests can inspect and manipulate state directly.
 */
export class CircuitBreaker {
  private endpoints: EndpointHealth[];
  private currentIndex = 0;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(urls: string[]) {
    this.endpoints = urls.map((url) => ({
      url,
      state: "closed",
      failures: 0,
      nextProbeAt: 0,
    }));
    this.scheduleHealthChecks();
  }

  /** Return a copy of all endpoint health records (for tests / monitoring). */
  getEndpoints(): ReadonlyArray<EndpointHealth> {
    return this.endpoints.map((e) => ({ ...e }));
  }

  /**
   * Pick the next available endpoint using round-robin, skipping open
   * circuits unless we are past their probe window (half-open attempt).
   * Returns null if all endpoints are unavailable.
   */
  nextEndpoint(): EndpointHealth | null {
    const total = this.endpoints.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const ep = this.endpoints[idx];
      if (ep.state === "closed") {
        this.currentIndex = (idx + 1) % total;
        return ep;
      }
      if (ep.state === "open" && Date.now() >= ep.nextProbeAt) {
        ep.state = "half-open";
        this.currentIndex = (idx + 1) % total;
        return ep;
      }
    }
    return null;
  }

  /** Called when a request to an endpoint succeeds. */
  recordSuccess(url: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep) return;
    ep.failures = 0;
    ep.state = "closed";
  }

  /**
   * Called when a request to an endpoint fails with a 5xx or 429 response.
   * Opens the circuit after CIRCUIT_BREAKER_THRESHOLD consecutive failures.
   */
  recordFailure(url: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep) return;
    ep.failures++;
    if (ep.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      ep.state = "open";
      ep.nextProbeAt = Date.now() + HEALTH_CHECK_INTERVAL_MS;
    }
  }

  /**
   * Probe all currently-open endpoints.  Called by the background timer and
   * exposed as a method so tests can invoke it directly.
   */
  async probeOpenEndpoints(): Promise<void> {
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (ep.state === "open" && now >= ep.nextProbeAt) {
        try {
          const { status } = await get(ep.url);
          if (status < 500 && status !== 429) {
            ep.state = "closed";
            ep.failures = 0;
          } else {
            ep.nextProbeAt = Date.now() + HEALTH_CHECK_INTERVAL_MS;
          }
        } catch {
          ep.nextProbeAt = Date.now() + HEALTH_CHECK_INTERVAL_MS;
        }
      }
    }
  }

  /**
   * Background loop: probe open endpoints every HEALTH_CHECK_INTERVAL_MS.
   */
  /* istanbul ignore next -- setInterval wiring not exercised in unit tests */
  private scheduleHealthChecks(): void {
    this.healthCheckTimer = setInterval(
      () => void this.probeOpenEndpoints(),
      HEALTH_CHECK_INTERVAL_MS,
    );
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /** Stop the background health-check interval (used in tests). */
  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }
}

export class HorizonService {
  private readonly breaker: CircuitBreaker;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    // Support comma-separated list of URLs
    const urls = baseUrl
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    this.breaker = new CircuitBreaker(urls.length > 0 ? urls : /* istanbul ignore next */ [DEFAULT_BASE_URL]);
  }

  /** Expose the circuit breaker for testing / monitoring. */
  getCircuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

  async fetchAccount(accountId: string): Promise<HorizonAccount | null> {
    let retries = 0;

    const attempt = async (): Promise<HorizonAccount | null> => {
      const ep = this.breaker.nextEndpoint();

      if (!ep) {
        throw new HorizonError(503, "All RPC endpoints are unavailable");
      }

      let status: number;
      let body: string;

      try {
        ({ status, body } = await get(`${ep.url}/accounts/${accountId}`));
      } catch (networkErr) {
        // Network-level error counts as a failure
        this.breaker.recordFailure(ep.url);
        throw new HorizonError(
          0,
          `Network error reaching ${ep.url}: ${(networkErr as Error).message}`
        );
      }

      if (status === 200) {
        this.breaker.recordSuccess(ep.url);

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new HorizonError(200, "Malformed JSON in Horizon response");
        }
        const account = parsed as Record<string, unknown>;
        if (
          typeof account.id !== "string" ||
          typeof account.sequence !== "string" ||
          !Array.isArray(account.balances)
        ) {
          throw new HorizonError(200, "Unexpected Horizon account shape");
        }
        return parsed as HorizonAccount;
      }

      if (status === 404) {
        this.breaker.recordSuccess(ep.url);
        return null;
      }

      // 5xx or 429 — record failure against this endpoint
      this.breaker.recordFailure(ep.url);

      if (status === 429 && retries < MAX_RETRIES - 1) {
        retries++;
        await delay(BASE_DELAY_MS * 2 ** (retries - 1));
        return attempt();
      }

      throw new HorizonError(
        status,
        status === 429
          ? "Rate limited by Horizon after retries"
          : `Horizon responded with ${status}`
      );
    };

    return attempt();
  }
}
