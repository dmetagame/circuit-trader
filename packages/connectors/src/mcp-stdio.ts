import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unwrapToolResult, type ToolResultLike } from "./mcp-transport.js";

/**
 * MCP transport over a child process's stdio. Spawns a local MCP server (e.g. the Trust
 * Wallet Agent Kit's `twak serve`) and speaks MCP over its stdin/stdout, behind the same
 * `{ callTool(name, args) }` shape the policy ports expect.
 *
 * The spawned CLI holds the credentials and does the HMAC request signing — our process
 * never sees or signs with the secret. Pass creds through `env` (e.g. TWAK_ACCESS_ID /
 * TWAK_HMAC_SECRET) or rely on the CLI's keychain.
 */
export interface McpStdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  clientName?: string;
  clientVersion?: string;
}

export class McpStdioTransport {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly opts: McpStdioTransportOptions) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.getClient();
    const res = (await client.callTool({ name, arguments: args })) as ToolResultLike;
    return unwrapToolResult(res);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close(); // also terminates the spawned child process
      this.client = null;
      this.connecting = null;
    }
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.connect();
    try {
      this.client = await this.connecting;
      return this.client;
    } catch (e) {
      this.connecting = null;
      throw e;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({
      name: this.opts.clientName ?? "circuit-trader",
      version: this.opts.clientVersion ?? "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: this.opts.command,
      ...(this.opts.args ? { args: this.opts.args } : {}),
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });
    await client.connect(transport);
    return client;
  }
}

/** Filter a process env (which has `string | undefined` values) down to defined strings. */
export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}
