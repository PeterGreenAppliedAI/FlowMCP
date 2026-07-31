import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export interface FixtureServer {
  baseUrl: string;
  close: () => Promise<void>;
}

// Hermetic stand-in for Open-Meteo and the HN Firebase API.
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (data: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/v1/search') {
      json({
        results: [
          { name: url.searchParams.get('name'), country: 'Testland', latitude: 1.5, longitude: 2.5 },
        ],
      });
    } else if (url.pathname === '/v1/forecast') {
      json({
        daily: {
          temperature_2m_max: [30.1],
          temperature_2m_min: [20.2],
          precipitation_probability_max: [15],
        },
      });
    } else if (url.pathname === '/v0/topstories.json') {
      json([101, 102, 103, 104, 105, 106, 107]);
    } else if (url.pathname.startsWith('/v0/item/')) {
      const id = Number(url.pathname.slice('/v0/item/'.length).replace('.json', ''));
      json({ id, title: `Story ${id}`, score: id, url: `https://example.com/${id}` });
    } else if (url.pathname === '/fail') {
      res.statusCode = 500;
      res.end('boom');
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function spawnServer(
  flowsDir: string,
  env: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--flows', flowsDir], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
  });
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

// Minimal newline-delimited JSON-RPC client speaking to the spawned server.
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, (msg: RpcResponse) => void>();
  private buffer = '';
  stderr = '';

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcResponse;
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    this.child.kill();
  }
}
