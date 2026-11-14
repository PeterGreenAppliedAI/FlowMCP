import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock only the read that loadRegistry performs, keyed on path: every other
// fs/promises function comes from the real module. EACCES is simulated this
// way rather than relying on filesystem permissions or the executing user's
// privileges.
const overrides = new Map<string, Error>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (path: string, encoding: BufferEncoding) => {
      if (typeof path === 'string' && overrides.has(path)) throw overrides.get(path);
      return actual.readFile(path, encoding);
    }),
  };
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { REGISTRY_FILE, loadRegistry } from '../src/registry.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flowmcp-registry-errors-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  overrides.clear();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('loadRegistry read errors', () => {
  it('returns undefined when registry.json5 is missing', async () => {
    const dir = await makeDir();
    expect(await loadRegistry(dir)).toBeUndefined();
  });

  it('rejects with EISDIR when registry.json5 is a directory', async () => {
    const dir = await makeDir();
    await mkdir(join(dir, REGISTRY_FILE));
    const error = await loadRegistry(dir).then(
      () => undefined,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.code).toBe('EISDIR');
  });

  it('rethrows a mocked EACCES read failure unchanged', async () => {
    const dir = await makeDir();
    const path = join(dir, REGISTRY_FILE);
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
      code: 'EACCES',
      errno: -13,
      syscall: 'open',
      path,
    });
    overrides.set(path, failure);
    const error = await loadRegistry(dir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(failure);
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('loads a candidate flow into the registry object', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, REGISTRY_FILE), `{ f: { state: 'candidate' } }`);
    expect(await loadRegistry(dir)).toEqual({ f: { state: 'candidate' } });
  });
});
