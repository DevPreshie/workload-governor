import nock from "nock";
import { HorizonService, HorizonAccount, CircuitBreaker, CircuitState } from "../HorizonService";
import { HorizonError } from "../HorizonError";

const BASE = "https://horizon-testnet.stellar.org";
const BASE2 = "https://horizon2-testnet.stellar.org";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const MOCK_ACCOUNT: HorizonAccount = {
  id: ACCOUNT_ID,
  sequence: "1234567890",
  balances: [{ balance: "100.0000000", asset_type: "native" }],
};

beforeEach(() => nock.cleanAll());
afterAll(() => nock.restore());

// ---------------------------------------------------------------------------
// Original single-endpoint tests (preserved for backwards-compatibility)
// ---------------------------------------------------------------------------

describe("HorizonService – single endpoint", () => {
  let svc: HorizonService;
  beforeEach(() => {
    svc = new HorizonService(BASE);
  });
  afterEach(() => svc.getCircuitBreaker().destroy());

  it("returns a parsed account on 200", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(200, MOCK_ACCOUNT);

    const account = await svc.fetchAccount(ACCOUNT_ID);

    expect(account).toEqual(MOCK_ACCOUNT);
  });

  it("returns null on 404 without throwing", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(404, { status: 404 });

    const account = await svc.fetchAccount(ACCOUNT_ID);

    expect(account).toBeNull();
  });

  it("retries on 429 and throws HorizonError after exhausting retries", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(429).persist();

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      name: "HorizonError",
      status: 429,
    });
  }, 10_000);

  it("throws HorizonError with status 200 on malformed JSON response", async () => {
    nock(BASE)
      .get(`/accounts/${ACCOUNT_ID}`)
      .reply(200, "{ not valid json !!!");

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      name: "HorizonError",
      status: 200,
      message: "Malformed JSON in Horizon response",
    });
  });

  it("throws HorizonError on unexpected account shape", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(200, { id: 123 });

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      name: "HorizonError",
      status: 200,
      message: "Unexpected Horizon account shape",
    });
  });

  it("throws HorizonError on non-200/404/429 status", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(500);

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      name: "HorizonError",
      status: 500,
    });
  });

  it("uses the default Horizon testnet base URL when constructed without arguments", async () => {
    const defaultSvc = new HorizonService();
    nock("https://horizon-testnet.stellar.org")
      .get(`/accounts/${ACCOUNT_ID}`)
      .reply(200, MOCK_ACCOUNT);

    const account = await defaultSvc.fetchAccount(ACCOUNT_ID);
    expect(account).toEqual(MOCK_ACCOUNT);
    defaultSvc.getCircuitBreaker().destroy();
  });
});

// ---------------------------------------------------------------------------
// Circuit-breaker unit tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;
  beforeEach(() => {
    cb = new CircuitBreaker([BASE, BASE2]);
  });
  afterEach(() => cb.destroy());

  it("starts with all endpoints closed", () => {
    const eps = cb.getEndpoints();
    expect(eps).toHaveLength(2);
    eps.forEach((ep) => expect(ep.state).toBe<CircuitState>("closed"));
  });

  it("records successes and keeps circuit closed", () => {
    cb.recordSuccess(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("closed");
    expect(cb.getEndpoints()[0].failures).toBe(0);
  });

  it("recordSuccess is a no-op for an unknown URL", () => {
    cb.recordSuccess("https://unknown.example.com");
    // Neither endpoint should be affected
    cb.getEndpoints().forEach((ep) => expect(ep.failures).toBe(0));
  });

  it("recordFailure is a no-op for an unknown URL", () => {
    cb.recordFailure("https://unknown.example.com");
    cb.getEndpoints().forEach((ep) => expect(ep.failures).toBe(0));
  });

  it("opens the circuit after 3 consecutive failures", () => {
    cb.recordFailure(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("closed");
    cb.recordFailure(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("closed");
    cb.recordFailure(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");
  });

  it("resets failure count and closes circuit on success after failures", () => {
    cb.recordFailure(BASE);
    cb.recordFailure(BASE);
    cb.recordSuccess(BASE);
    const ep = cb.getEndpoints()[0];
    expect(ep.state).toBe<CircuitState>("closed");
    expect(ep.failures).toBe(0);
  });

  it("nextEndpoint skips open circuits and returns the next available one", () => {
    // Trip BASE
    cb.recordFailure(BASE);
    cb.recordFailure(BASE);
    cb.recordFailure(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");

    const ep = cb.nextEndpoint();
    expect(ep?.url).toBe(BASE2);
  });

  it("returns null when all endpoints are open", () => {
    [BASE, BASE2].forEach((url) => {
      for (let i = 0; i < 3; i++) cb.recordFailure(url);
    });
    expect(cb.nextEndpoint()).toBeNull();
  });

  it("transitions to half-open when probe window has elapsed", () => {
    // Trip BASE
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);

    // Back-date the probe window so it appears expired
    const eps = (cb as unknown as { endpoints: Array<{ url: string; state: CircuitState; failures: number; nextProbeAt: number }> }).endpoints;
    eps[0].nextProbeAt = Date.now() - 1;

    const ep = cb.nextEndpoint();
    expect(ep?.url).toBe(BASE);
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("half-open");
  });

  it("restores endpoint to closed after successful half-open probe", () => {
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    cb.recordSuccess(BASE); // Simulate successful probe
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("closed");
    expect(cb.getEndpoints()[0].failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// probeOpenEndpoints tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker.probeOpenEndpoints", () => {
  let cb: CircuitBreaker;
  beforeEach(() => {
    cb = new CircuitBreaker([BASE, BASE2]);
  });
  afterEach(() => {
    cb.destroy();
    nock.cleanAll();
  });

  it("restores an open endpoint to closed when probe succeeds with 200", async () => {
    // Trip BASE
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    // Back-date probe window
    const eps = (cb as unknown as { endpoints: Array<{ url: string; state: CircuitState; failures: number; nextProbeAt: number }> }).endpoints;
    eps[0].nextProbeAt = Date.now() - 1;

    nock(BASE).get("/").reply(200, "ok");
    await cb.probeOpenEndpoints();

    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("closed");
    expect(cb.getEndpoints()[0].failures).toBe(0);
  });

  it("keeps endpoint open and reschedules probe when probe returns 500", async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    const eps = (cb as unknown as { endpoints: Array<{ url: string; state: CircuitState; failures: number; nextProbeAt: number }> }).endpoints;
    eps[0].nextProbeAt = Date.now() - 1;

    nock(BASE).get("/").reply(500);
    await cb.probeOpenEndpoints();

    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");
    expect(cb.getEndpoints()[0].nextProbeAt).toBeGreaterThan(Date.now());
  });

  it("keeps endpoint open and reschedules probe when probe returns 429", async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    const eps = (cb as unknown as { endpoints: Array<{ url: string; state: CircuitState; failures: number; nextProbeAt: number }> }).endpoints;
    eps[0].nextProbeAt = Date.now() - 1;

    nock(BASE).get("/").reply(429);
    await cb.probeOpenEndpoints();

    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");
  });

  it("keeps endpoint open and reschedules on network error during probe", async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    const eps = (cb as unknown as { endpoints: Array<{ url: string; state: CircuitState; failures: number; nextProbeAt: number }> }).endpoints;
    eps[0].nextProbeAt = Date.now() - 1;

    nock(BASE).get("/").replyWithError("probe network error");
    await cb.probeOpenEndpoints();

    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");
    expect(cb.getEndpoints()[0].nextProbeAt).toBeGreaterThan(Date.now());
  });

  it("skips endpoints that are closed", async () => {
    // Both endpoints closed — probe should be a no-op
    await cb.probeOpenEndpoints();
    cb.getEndpoints().forEach((ep) => expect(ep.state).toBe<CircuitState>("closed"));
  });

  it("skips endpoints whose probe window has not elapsed", async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE);
    // Do NOT back-date nextProbeAt — it should be in the future
    const initialProbeAt = cb.getEndpoints()[0].nextProbeAt;

    await cb.probeOpenEndpoints(); // should do nothing

    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");
    expect(cb.getEndpoints()[0].nextProbeAt).toBe(initialProbeAt);
  });
});

// ---------------------------------------------------------------------------
// Multi-endpoint failover integration tests
// ---------------------------------------------------------------------------

describe("HorizonService – multi-endpoint failover", () => {
  let svc: HorizonService;
  beforeEach(() => {
    svc = new HorizonService(`${BASE},${BASE2}`);
  });
  afterEach(() => {
    svc.getCircuitBreaker().destroy();
    nock.cleanAll();
  });

  it("uses both endpoints (round-robin)", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(200, MOCK_ACCOUNT);
    nock(BASE2).get(`/accounts/${ACCOUNT_ID}`).reply(200, MOCK_ACCOUNT);

    const first = await svc.fetchAccount(ACCOUNT_ID);
    const second = await svc.fetchAccount(ACCOUNT_ID);

    expect(first).toEqual(MOCK_ACCOUNT);
    expect(second).toEqual(MOCK_ACCOUNT);
  });

  it("fails over to second endpoint when primary returns 503", async () => {
    // Trip BASE by making it fail 3 times consecutively
    // We need to control which URL is used, so manually trip the circuit breaker
    const cb = svc.getCircuitBreaker();

    // Record 3 failures on BASE to open its circuit
    for (let i = 0; i < 3; i++) {
      cb.recordFailure(BASE);
    }
    expect(cb.getEndpoints()[0].state).toBe<CircuitState>("open");

    // Now all requests should go to BASE2
    nock(BASE2).get(`/accounts/${ACCOUNT_ID}`).reply(200, MOCK_ACCOUNT);

    const result = await svc.fetchAccount(ACCOUNT_ID);
    expect(result).toEqual(MOCK_ACCOUNT);
  });

  it("throws HorizonError 503 when all endpoints are unavailable", async () => {
    const cb = svc.getCircuitBreaker();
    // Manually open all circuits
    for (let i = 0; i < 3; i++) {
      cb.recordFailure(BASE);
      cb.recordFailure(BASE2);
    }

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      status: 503,
      message: "All RPC endpoints are unavailable",
    });
  });

  it("records success on primary and resets circuit after failover", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).reply(200, MOCK_ACCOUNT);

    await svc.fetchAccount(ACCOUNT_ID);

    const eps = svc.getCircuitBreaker().getEndpoints();
    expect(eps[0].state).toBe<CircuitState>("closed");
    expect(eps[0].failures).toBe(0);
  });

  it("records failure and throws HorizonError on network-level error", async () => {
    nock(BASE).get(`/accounts/${ACCOUNT_ID}`).replyWithError("connection refused");
    // Trip BASE2 so only BASE is selected
    const cb = svc.getCircuitBreaker();
    for (let i = 0; i < 3; i++) cb.recordFailure(BASE2);

    await expect(svc.fetchAccount(ACCOUNT_ID)).rejects.toMatchObject({
      name: "HorizonError",
      status: 0,
      message: expect.stringContaining("Network error"),
    });

    // Failure should have been recorded on BASE
    expect(cb.getEndpoints()[0].failures).toBeGreaterThan(0);
  });
});
