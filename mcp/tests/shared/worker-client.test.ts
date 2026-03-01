import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import {
  WorkerAPIClient,
  CircuitState,
} from "../../src/shared/client/worker-client.js";
import {
  WorkerUnavailableError,
  WorkerAPIError,
} from "../../src/shared/client/exceptions.js";

const BASE_URL = "http://localhost:8080";

function createClient(
  overrides?: {
    failureThreshold?: number;
    recoveryTimeout?: number;
    maxRetries?: number;
  },
) {
  return new WorkerAPIClient(BASE_URL, {
    failureThreshold: overrides?.failureThreshold ?? 3,
    recoveryTimeout: overrides?.recoveryTimeout ?? 30,
    connectTimeout: 1,
    readTimeout: 1,
    maxRetries: overrides?.maxRetries ?? 1,
  });
}

describe("WorkerAPIClient", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("success returns JSON and state is CLOSED", async () => {
    const client = createClient();
    nock(BASE_URL).get("/api/alerts/").reply(200, { data: [] });

    const result = await client.listAlerts();
    expect(result).toEqual({ data: [] });
    expect(client.state).toBe(CircuitState.CLOSED);
    expect(client.failureCount).toBe(0);
  });

  it("circuit opens after threshold failures", async () => {
    const client = createClient({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      nock(BASE_URL).get("/api/worker/status").reply(500, "error");
      await expect(client.getWorkerStatus()).rejects.toThrow(
        WorkerUnavailableError,
      );
    }

    expect(client.state).toBe(CircuitState.OPEN);
    expect(client.failureCount).toBe(3);
  });

  it("open circuit throws immediately without HTTP call", async () => {
    const client = createClient({ failureThreshold: 1 });

    // Trip the circuit
    nock(BASE_URL).get("/api/worker/status").reply(500, "error");
    await expect(client.getWorkerStatus()).rejects.toThrow(
      WorkerUnavailableError,
    );
    expect(client.state).toBe(CircuitState.OPEN);

    // This should NOT make an HTTP call
    const scope = nock(BASE_URL).get("/api/worker/status").reply(200, {});
    await expect(client.getWorkerStatus()).rejects.toThrow(
      WorkerUnavailableError,
    );
    expect(scope.isDone()).toBe(false);
  });

  it("half-open allows probe after recovery timeout", async () => {
    const client = createClient({
      failureThreshold: 1,
      recoveryTimeout: 0,
    });

    // Trip the circuit
    nock(BASE_URL).get("/api/worker/status").reply(500, "error");
    await expect(client.getWorkerStatus()).rejects.toThrow(
      WorkerUnavailableError,
    );
    expect(client.state).toBe(CircuitState.OPEN);

    // With recoveryTimeout=0, the next call should transition to HALF_OPEN
    nock(BASE_URL).get("/api/worker/status").reply(200, { running: true });
    const result = await client.getWorkerStatus();
    expect(result).toEqual({ running: true });
    expect(client.state).toBe(CircuitState.CLOSED);
    expect(client.failureCount).toBe(0);
  });

  it("4xx does NOT trip circuit breaker", async () => {
    const client = createClient();
    nock(BASE_URL).get("/api/alerts/bad-id").reply(404, { message: "Not found" });

    await expect(client.getAlert("bad-id")).rejects.toThrow(WorkerAPIError);
    expect(client.state).toBe(CircuitState.CLOSED);
    expect(client.failureCount).toBe(0);
  });

  it("5xx retried up to maxRetries", async () => {
    const client = createClient({ maxRetries: 2 });

    nock(BASE_URL)
      .get("/api/worker/status")
      .reply(500, "error")
      .get("/api/worker/status")
      .reply(200, { running: true });

    const result = await client.getWorkerStatus();
    expect(result).toEqual({ running: true });
  });

  it("isAvailable bypasses circuit breaker", async () => {
    const client = createClient({ failureThreshold: 1 });

    // Trip the circuit
    nock(BASE_URL).get("/api/worker/status").reply(500, "error");
    await expect(client.getWorkerStatus()).rejects.toThrow(
      WorkerUnavailableError,
    );
    expect(client.state).toBe(CircuitState.OPEN);

    // isAvailable should still make a request
    nock(BASE_URL).get("/health").reply(200);
    const available = await client.isAvailable();
    expect(available).toBe(true);
  });

  it("isAvailable returns false on network error", async () => {
    const client = createClient();
    nock(BASE_URL).get("/health").replyWithError("connection refused");

    const available = await client.isAvailable();
    expect(available).toBe(false);
  });

  it("204 returns empty object", async () => {
    const client = createClient();
    nock(BASE_URL).delete("/api/alerts/abc").reply(204);

    const result = await client.deleteAlert("abc");
    expect(result).toBeUndefined();
  });

  it("WorkerAPIError carries statusCode", async () => {
    const client = createClient();
    nock(BASE_URL).get("/api/alerts/bad").reply(422, { message: "Invalid" });

    try {
      await client.getAlert("bad");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerAPIError);
      expect((e as WorkerAPIError).statusCode).toBe(422);
    }
  });

  it("success resets failureCount", async () => {
    const client = createClient({ failureThreshold: 3 });

    // Accumulate 2 failures (below threshold)
    nock(BASE_URL).get("/api/worker/status").reply(500, "err");
    await expect(client.getWorkerStatus()).rejects.toThrow();
    nock(BASE_URL).get("/api/worker/status").reply(500, "err");
    await expect(client.getWorkerStatus()).rejects.toThrow();
    expect(client.failureCount).toBe(2);

    // Success should reset
    nock(BASE_URL).get("/api/worker/status").reply(200, { running: true });
    await client.getWorkerStatus();
    expect(client.failureCount).toBe(0);
  });

  it("network error increments failureCount", async () => {
    const client = createClient();
    nock(BASE_URL)
      .get("/api/worker/status")
      .replyWithError("connection refused");

    await expect(client.getWorkerStatus()).rejects.toThrow(
      WorkerUnavailableError,
    );
    expect(client.failureCount).toBe(1);
  });
});
