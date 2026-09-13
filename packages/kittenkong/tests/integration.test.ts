/**
 * Integration Tests for KittenKong Client
 *
 * PURPOSE:
 * Integration tests against live FunkyGibbon server. Tests actual HTTP communication,
 * authentication flows, sync operations, and entity management. These tests require
 * a running FunkyGibbon server instance.
 *
 * TEST STRUCTURE:
 * - Uses Vitest with BDD Given/When/Then pattern
 * - Tests against localhost:8000 by default
 * - Mocks can be disabled for true integration testing
 * - Tests both success and failure scenarios
 *
 * ENVIRONMENT:
 * Runs against the isolated FunkyGibbon the suite starts itself (see
 * tests/helpers/funkygibbon-server.ts), read from the harness handshake.
 * FUNKYGIBBON_URL / FUNKYGIBBON_TOKEN / FUNKYGIBBON_ADMIN_PASSWORD still
 * override it for pointing at a server of your own.
 *
 * VERSION HISTORY:
 * - 2026-09-13: Use the isolated harness instead of a hardcoded
 *   localhost:8000. That default was the exact hazard the harness exists to
 *   remove -- on a machine with a real install it ran against production
 *   data, and on one without it spent ~55 s per run timing out on connects
 *   and failing six tests that had nothing to do with the code under test.
 *   The sync tests no longer skip for want of a token: the harness has one.
 * - 2025-04-02: Initial integration test suite with BDD structure
 *
 * PORTED FROM:
 * Python: blowing-off/tests/integration/test_client_integration.py
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { KittenKongClient } from '../src/client';
import { AuthManager } from '../src/auth';
import type { Entity, EntityType } from '@the-goodies/inbetweenies';
import { readHandshake } from './helpers/funkygibbon-server';

// Test configuration -- resolved from the harness handshake before any test
// runs; an explicit env var wins so the file can still target a server of
// your own. Never a hardcoded port.
let SERVER_URL = process.env.FUNKYGIBBON_URL || '';
let ADMIN_PASSWORD = process.env.FUNKYGIBBON_ADMIN_PASSWORD;
let AUTH_TOKEN = process.env.FUNKYGIBBON_TOKEN;

beforeAll(async () => {
  const handshake = await readHandshake();
  if (handshake) {
    SERVER_URL ||= handshake.baseUrl;
    AUTH_TOKEN ||= handshake.token;
    ADMIN_PASSWORD ||= handshake.adminPassword;
  }
  if (!SERVER_URL) {
    throw new Error('No FunkyGibbon to test against: harness unavailable and FUNKYGIBBON_URL unset');
  }
});

const syncHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
});

// Sync and admin-login assertions need credentials. The harness always
// provides them, so these only skip when pointed at a foreign server without
// a token -- and the skip is visible in the run summary, never silent.
const syncTest = test;

describe('KittenKong Integration Tests', () => {
  describe('Server Connectivity', () => {
    test('should connect to FunkyGibbon health endpoint', async () => {
      // Given: A FunkyGibbon server running at SERVER_URL

      // When: We request the health endpoint
      const response = await fetch(`${SERVER_URL}/health`);
      const data = await response.json();

      // Then: Server should respond with healthy status
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('status');
      expect(data.status).toBe('healthy');
    });

    test('should handle connection to non-existent server gracefully', async () => {
      // Given: A non-existent server URL
      const badUrl = 'http://localhost:9999';

      // When: We attempt to connect
      const result = await fetch(`${badUrl}/health`)
        .then(() => true)
        .catch(() => false);

      // Then: Connection should fail gracefully
      expect(result).toBe(false);
    });
  });

  describe('API Endpoints', () => {
    test('should receive Not Found for undefined endpoint', async () => {
      // Given: An undefined API endpoint

      // When: We request the undefined endpoint
      const response = await fetch(`${SERVER_URL}/api/v1/nonexistent`);

      // Then: Server should return 404
      expect(response.status).toBe(404);
    });

    syncTest('should have sync endpoint defined and responding', async () => {
      // Given: The sync endpoint path and a valid sync request

      // When: We make a sync request
      const response = await fetch(`${SERVER_URL}/api/v1/sync/`, {
        method: 'POST',
        headers: syncHeaders(),
        body: JSON.stringify({
          protocol_version: 'inbetweenies-v3',
          device_id: 'test-client',
          user_id: 'test',
          sync_type: 'full',
          changes: []
        })
      });

      // Then: Should receive successful response with sync data
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toHaveProperty('protocol_version');
      expect(data).toHaveProperty('sync_type');
      expect(data).toHaveProperty('changes');
      expect(Array.isArray(data.changes)).toBe(true);
    });
  });

  describe('Authentication Manager Integration', () => {
    test('should initialize auth manager with server URL', () => {
      // Given: Server configuration

      // When: We create an AuthManager
      const auth = new AuthManager({ serverUrl: SERVER_URL });

      // Then: Auth manager should be properly configured
      expect(auth.serverUrl).toBe(SERVER_URL);
      expect(auth.token).toBeNull();
      expect(auth.isAuthenticated()).toBe(false);
    });

    test('should handle admin login attempt with wrong password', async () => {
      // Given: An AuthManager and wrong password
      const auth = new AuthManager({ serverUrl: SERVER_URL });
      const wrongPassword = 'definitely_wrong_password';

      // When: We attempt to login with wrong password
      const result = await auth.loginAdmin(wrongPassword);

      // Then: Login should fail gracefully
      expect(result).toBe(false);
      expect(auth.token).toBeNull();
      expect(auth.isAuthenticated()).toBe(false);
    }, { timeout: 10000 });

    // Skip admin login test if password not provided
    test('should successfully login as admin with correct password', async ({ skip }) => {
      if (!ADMIN_PASSWORD) skip();
      // Given: An AuthManager and correct admin password
      const auth = new AuthManager({ serverUrl: SERVER_URL });

      // When: We attempt to login with correct password
      const result = await auth.loginAdmin(ADMIN_PASSWORD!);

      // Then: Login should succeed and token should be set
      expect(result).toBe(true);
      expect(auth.token).not.toBeNull();
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.role).toBe('admin');
      expect(auth.permissions).toContain('read');
      expect(auth.permissions).toContain('write');

      // Cleanup
      await auth.logout();
    }, { timeout: 10000 });
  });

  describe('Client Initialization', () => {
    test('should initialize client with server URL', () => {
      // Given: Server configuration
      const options = {
        serverUrl: SERVER_URL,
        clientId: 'test-client-init'
      };

      // When: We create a KittenKongClient
      const client = new KittenKongClient(options);

      // Then: Client should be properly configured
      expect(client.serverUrl).toBe(SERVER_URL);
      expect(client.clientId).toBe('test-client-init');
    });

    test('should generate client ID if not provided', () => {
      // Given: Configuration without client ID
      const options = {
        serverUrl: SERVER_URL
      };

      // When: We create a KittenKongClient
      const client = new KittenKongClient(options);

      // Then: Client should generate an ID automatically
      expect(client.clientId).toBeDefined();
      expect(client.clientId).toMatch(/^kittenkong-/);
    });
  });

  describe('Protocol Validation', () => {
    test('should structure sync request according to Inbetweenies protocol', () => {
      // Given: The Inbetweenies v3 protocol specification
      const syncRequest = {
        protocol_version: 'inbetweenies-v3',
        device_id: 'test-device',
        user_id: 'test-user',
        sync_type: 'full',
        changes: []
      };

      // When: We validate the structure

      // Then: Request should have all required fields
      expect(syncRequest).toHaveProperty('protocol_version');
      expect(syncRequest).toHaveProperty('device_id');
      expect(syncRequest).toHaveProperty('user_id');
      expect(syncRequest).toHaveProperty('sync_type');
      expect(syncRequest).toHaveProperty('changes');

      // And: Protocol version should be correct
      expect(syncRequest.protocol_version).toBe('inbetweenies-v3');

      // And: Sync type should be valid
      expect(['full', 'delta']).toContain(syncRequest.sync_type);
    });
  });

  describe('Error Handling', () => {
    test('should handle network timeouts gracefully', async () => {
      // Given: A request with very short timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1); // 1ms timeout

      // When: We make a request that will timeout
      const result = await fetch(`${SERVER_URL}/health`, {
        signal: controller.signal
      })
        .then(() => 'success')
        .catch((error) => {
          if (error.name === 'AbortError') return 'timeout';
          return 'other_error';
        });

      // Then: Should handle timeout gracefully
      // Note: May succeed if server is very fast, but should handle gracefully either way
      expect(['success', 'timeout']).toContain(result);

      clearTimeout(timeoutId);
    });

    test('should parse JSON error responses', async () => {
      // Given: An endpoint that returns JSON error

      // When: We request a non-existent endpoint
      const response = await fetch(`${SERVER_URL}/api/v1/nonexistent`);

      // Then: Should be able to parse error as JSON
      expect(response.headers.get('content-type')).toContain('application/json');
      const error = await response.json();
      expect(error).toHaveProperty('detail');
    });
  });
});

describe('Client-Server Communication', () => {
  let client: KittenKongClient;

  beforeAll(() => {
    // Given: A configured client for all communication tests
    client = new KittenKongClient({
      serverUrl: SERVER_URL,
      clientId: 'integration-test-client'
    });
  });

  describe('Health Checks', () => {
    test('should check server health', async () => {
      // Given: A configured client (from beforeAll)

      // When: We check server health
      const response = await fetch(`${client.serverUrl}/health`);
      const isHealthy = response.ok;

      // Then: Server should be healthy
      expect(isHealthy).toBe(true);
    });
  });

  describe('Sync Protocol', () => {
    syncTest('should successfully perform full sync request', async () => {
      // Given: A client with sync request

      // When: We perform a full sync
      const response = await fetch(`${SERVER_URL}/api/v1/sync/`, {
        method: 'POST',
        headers: syncHeaders(),
        body: JSON.stringify({
          protocol_version: 'inbetweenies-v3',
          device_id: client.clientId,
          user_id: 'test',
          sync_type: 'full',
          changes: []
        })
      });

      // Then: Should receive successful sync response
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();

      // And: Response should follow Inbetweenies protocol
      expect(data.protocol_version).toBe('inbetweenies-v3');
      expect(data.sync_type).toBe('full');
      expect(Array.isArray(data.changes)).toBe(true);

      // And: May contain entities from the populated database
      console.log(`Received ${data.changes.length} entities from server`);
    });

    syncTest('should handle delta sync requests', async () => {
      // Given: A client with previous sync

      // When: We perform a delta sync
      const response = await fetch(`${SERVER_URL}/api/v1/sync/`, {
        method: 'POST',
        headers: syncHeaders(),
        body: JSON.stringify({
          protocol_version: 'inbetweenies-v3',
          device_id: client.clientId,
          user_id: 'test',
          sync_type: 'delta',
          changes: [],
          filters: {
            since: new Date(Date.now() - 3600000).toISOString() // 1 hour ago
          }
        })
      });

      // Then: Should receive successful sync response
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.protocol_version).toBe('inbetweenies-v3');
      expect(Array.isArray(data.changes)).toBe(true);
    });
  });
});

describe('Performance Characteristics', () => {
  test('should respond to health check within reasonable time', async () => {
    // Given: A target response time of 100ms
    const targetTime = 100;
    const startTime = Date.now();

    // When: We request the health endpoint
    await fetch(`${SERVER_URL}/health`);
    const duration = Date.now() - startTime;

    // Then: Response should be fast (or at least complete)
    // Note: We're lenient here since CI environments vary
    expect(duration).toBeLessThan(5000); // 5 second max

    // Log actual time for monitoring
    console.log(`Health check completed in ${duration}ms (target: ${targetTime}ms)`);
  });

  test('should handle concurrent requests', async () => {
    // Given: Multiple concurrent health check requests
    const concurrentRequests = 5;

    // When: We make multiple requests simultaneously
    const promises = Array.from({ length: concurrentRequests }, () =>
      fetch(`${SERVER_URL}/health`)
    );

    const results = await Promise.all(promises);

    // Then: All requests should succeed
    expect(results).toHaveLength(concurrentRequests);
    results.forEach(response => {
      expect(response.ok).toBe(true);
    });
  });
});
