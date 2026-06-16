import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * A reusable MCP-over-HTTP transport. Wraps the official MCP client + Streamable HTTP
 * transport behind the tiny `{ callTool(name, args) }` shape that both `CmcMcpSource`
 * (McpTransport) and `TrustWalletWallet` (TwakTransport) expect. Lazy-connects on first
 * call and memoizes the client.
 */

/** Structural view of an MCP CallToolResult — version-tolerant. */
export interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Normalize an MCP tool result into the plain JSON object our parsers consume:
 * prefer `structuredContent`, else parse the first text block as JSON, else hand back
 * the raw text/content. Throws on `isError`.
 */
export function unwrapToolResult(res: ToolResultLike): unknown {
  const text = res.content?.find((c) => c.type === "text")?.text;

  if (res.isError) {
    throw new Error(`MCP tool error: ${text ?? "unknown"}`);
  }
  if (res.structuredContent != null) return res.structuredContent;
  if (text != null) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return res.content ?? {};
}

export interface McpHttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
}

export class McpHttpTransport {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly opts: McpHttpTransportOptions) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.getClient();
    const res = (await client.callTool({ name, arguments: args })) as ToolResultLike;
    return unwrapToolResult(res);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
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
      this.connecting = null; // allow retry on next call
      throw e;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({
      name: this.opts.clientName ?? "circuit-trader",
      version: this.opts.clientVersion ?? "0.1.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: this.opts.headers ?? {} },
    });
    await client.connect(transport);
    return client;
  }
}
