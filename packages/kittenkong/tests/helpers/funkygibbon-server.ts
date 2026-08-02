/**
 * Isolated FunkyGibbon server harness for integration tests.
 *
 * PURPOSE:
 * Starts a private FunkyGibbon server on a freshly allocated ephemeral port
 * with its own throwaway SQLite database, so the integration suite never
 * touches a developer's running install and never collides on port 8000.
 *
 * WHY THIS EXISTS (the bug it prevents):
 * The previous tests hardcoded localhost:8000 and probed /health to decide the
 * server was ready. That check cannot distinguish "my server came up" from
 * "somebody else's server was already listening there". On a machine with a
 * real install running — which is the normal case for this project — the suite
 * silently ran against production data, and after auth hardening simply
 * returned 401. This harness removes both halves of that failure mode:
 *
 *   - the port is allocated by the OS and asserted never to be 8000;
 *   - readiness is only accepted once the responder is PROVEN to be ours: our
 *     subprocess is still alive, it accepts an admin password only we know,
 *     and it honours the JWT it just issued. A stranger's server on a stray
 *     port cannot satisfy all three.
 *
 * Mirrors the Python harness at the-goodies/conftest.py (commit ff30ab2), so
 * both suites isolate the same way. Auth is exercised for real: a genuine
 * Argon2 hash and signing secret, with FUNKYGIBBON_TEST_MODE explicitly off.
 *
 * ENVIRONMENT:
 * - FUNKYGIBBON_REPO   path to the Python repo (default: discovery, see below)
 * - FUNKYGIBBON_PYTHON interpreter (default: <repo>/venv/bin/python, else python3)
 *
 * If the Python side cannot be located the harness reports unavailable rather
 * than throwing, and the integration tests skip with an explicit reason. It
 * never silently passes.
 *
 * VERSION HISTORY:
 * - 2026-08-01: Initial harness; ephemeral port + seeded temp DB + ownership proof.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

/** The port a real install owns. Never bind it, never probe it. */
const FORBIDDEN_PORT = 8000;

const SERVER_START_TIMEOUT_MS = 60_000;

/** Must satisfy PasswordManager.check_password_strength(). */
const TEST_ADMIN_PASSWORD = 'TestAdmin#2024!';

/**
 * Must not be a value funkygibbon treats as insecure (see
 * funkygibbon/api/routers/auth.py::_INSECURE_SECRETS), or the server refuses
 * to start without FUNKYGIBBON_TEST_MODE.
 */
const TEST_JWT_SECRET = 'kittenkong-integration-test-signing-secret-4d7a1e93';

/** Where globalSetup publishes the live server details for the test workers. */
export const HANDSHAKE_PATH = resolve(__dirname, '../../node_modules/.tmp/funkygibbon-test-server.json');

export interface ServerHandle {
  baseUrl: string;
  token: string;
  adminPassword: string;
}

interface RunningServer extends ServerHandle {
  process: ChildProcess;
  workDir: string;
}

/** Locate the Python repo. Explicit env wins; otherwise try the usual spots. */
export function findFunkygibbonRepo(): string | null {
  const explicit = process.env.FUNKYGIBBON_REPO;
  if (explicit) return existsSync(join(explicit, 'funkygibbon')) ? explicit : null;

  const candidates = [
    resolve(__dirname, '../../../../../the-goodies'),
    resolve(__dirname, '../../../../the-goodies-python'),
    join(homedir(), 'the-goodies'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'funkygibbon', 'populate_graph_db.py'))) return dir;
  }
  return null;
}

export function findPython(repo: string): string | null {
  const explicit = process.env.FUNKYGIBBON_PYTHON;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const venv = join(repo, 'venv', 'bin', 'python');
  if (existsSync(venv)) return venv;

  const probe = spawnSync('python3', ['-c', 'import funkygibbon'], { cwd: repo, encoding: 'utf8' });
  return probe.status === 0 ? 'python3' : null;
}

/** Ask the OS for an unused loopback port, never the forbidden one. */
async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((res, rej) => {
      const srv = createServer();
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => res(p));
      });
    });
    if (port && port !== FORBIDDEN_PORT) return port;
  }
  throw new Error('Could not allocate a free ephemeral port');
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Block until OUR server answers /health.
 *
 * The child's exit status is re-checked every attempt: if it died we fail
 * immediately with its output rather than polling a port a stranger may answer.
 */
async function awaitHealth(child: ChildProcess, baseUrl: string, output: () => string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `FunkyGibbon test server exited with code ${child.exitCode} before becoming ready.\n${output()}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.json())?.status === 'healthy') return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    await sleep(250);
  }
  throw new Error(
    `FunkyGibbon test server at ${baseUrl} was not healthy within ` +
      `${SERVER_START_TIMEOUT_MS / 1000}s (last: ${lastError}).\n${output()}`
  );
}

/**
 * Obtain a real admin JWT. Doubles as proof of server identity: only a server
 * started with our Argon2 hash accepts this password, and only one holding our
 * secret can mint a token /auth/me then honours.
 */
async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `Admin login against ${baseUrl} failed with HTTP ${res.status}. ` +
        `The server on this port is not the one this harness started.`
    );
  }
  const token = (await res.json()).access_token as string;

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!me.ok || (await me.json())?.role !== 'admin') {
    throw new Error(
      `Server at ${baseUrl} did not honour the token it just issued (HTTP ${me.status}). ` +
        `Refusing to run tests against it.`
    );
  }
  return token;
}

/**
 * Start an isolated server. Throws loudly on any startup failure — a test run
 * against the wrong server, or an unseeded one, is worse than no test run.
 */
export async function startFunkygibbon(): Promise<RunningServer> {
  const repo = findFunkygibbonRepo();
  if (!repo) throw new Error('FunkyGibbon repo not found; set FUNKYGIBBON_REPO');
  const python = findPython(repo);
  if (!python) throw new Error(`No usable Python for ${repo}; set FUNKYGIBBON_PYTHON`);

  const workDir = await mkdtemp(join(tmpdir(), 'kittenkong-fg-'));
  const dbPath = join(workDir, 'test.db');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Hash the password with the server's own PasswordManager so the real
  // verification path is what the tests exercise.
  const hashed = spawnSync(
    python,
    ['-c', 'from funkygibbon.auth import PasswordManager; import sys; print(PasswordManager().hash_password(sys.argv[1]))', TEST_ADMIN_PASSWORD],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PYTHONPATH: repo } }
  );
  if (hashed.status !== 0) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error(`Could not hash the test admin password:\n${hashed.stderr}`);
  }

  const env = {
    ...process.env,
    PYTHONPATH: repo,
    DATABASE_URL: `sqlite+aiosqlite:///${dbPath}`,
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    ADMIN_PASSWORD_HASH: hashed.stdout.trim(),
    JWT_SECRET: TEST_JWT_SECRET,
    BACKUP_SCHEDULE_ENABLED: 'false',
  } as NodeJS.ProcessEnv;
  delete env.FUNKYGIBBON_TEST_MODE;
  delete env.FUNKYGIBBON_TEST_PASSWORD;
  delete env.SECRET_KEY;

  // Seed BEFORE the server opens the database: population truncates and
  // rewrites the graph tables, which is safer without a live writer attached.
  // Fatal on failure — silently testing against an empty graph is how a
  // "passing" suite stops meaning anything.
  const seed = spawnSync(python, [join(repo, 'funkygibbon', 'populate_graph_db.py')], {
    cwd: workDir,
    env,
    encoding: 'utf8',
  });
  if (seed.status !== 0) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error(`populate_graph_db.py failed (exit ${seed.status}).\n${seed.stdout}\n${seed.stderr}`);
  }

  const child = spawn(python, ['-m', 'funkygibbon'], { cwd: workDir, env });
  let captured = '';
  child.stdout?.on('data', d => { captured += d; });
  child.stderr?.on('data', d => { captured += d; });
  const output = () => `--- server output ---\n${captured.slice(-4000)}`;

  try {
    await awaitHealth(child, baseUrl, output);
    const token = await login(baseUrl);
    return { baseUrl, token, adminPassword: TEST_ADMIN_PASSWORD, process: child, workDir };
  } catch (err) {
    child.kill('SIGTERM');
    await rm(workDir, { recursive: true, force: true });
    throw err;
  }
}

export async function stopFunkygibbon(server: RunningServer): Promise<void> {
  if (server.process.exitCode === null) {
    server.process.kill('SIGTERM');
    for (let i = 0; i < 40 && server.process.exitCode === null; i++) await sleep(250);
    if (server.process.exitCode === null) server.process.kill('SIGKILL');
  }
  await rm(server.workDir, { recursive: true, force: true });
}

export async function publishHandshake(handle: ServerHandle): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(HANDSHAKE_PATH), { recursive: true });
  await writeFile(HANDSHAKE_PATH, JSON.stringify(handle), 'utf8');
}

export async function clearHandshake(): Promise<void> {
  await rm(HANDSHAKE_PATH, { force: true });
}

/**
 * Read the server details published by globalSetup. Returns null when the
 * harness did not start (Python side unavailable) so tests can skip with a
 * reason rather than fail obscurely.
 */
export async function readHandshake(): Promise<ServerHandle | null> {
  try {
    return JSON.parse(await readFile(HANDSHAKE_PATH, 'utf8')) as ServerHandle;
  } catch {
    return null;
  }
}
