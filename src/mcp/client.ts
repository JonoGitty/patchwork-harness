/**
 * MCP (Model Context Protocol) client interface.
 *
 * M1: stub. The interface is fixed so the rest of the code compiles and
 * we have somewhere obvious to wire the real client into in M2.
 *
 * The real client will speak JSON-RPC 2.0 over stdio (for spawned
 * servers) or HTTP+SSE (for hosted servers), per the MCP spec.
 */

export interface MCPServerConfig {
  name: string;
  /** stdio: a command + args. http: a URL. */
  transport: { kind: "stdio"; command: string; args: string[] } | { kind: "http"; url: string };
  env?: Record<string, string>;
}

export interface MCPTool {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPClient {
  list(): Promise<MCPTool[]>;
  call(server: string, name: string, input: unknown): Promise<{ content: string; isError?: boolean }>;
}

export class StubMCPClient implements MCPClient {
  async list(): Promise<MCPTool[]> {
    return [];
  }
  async call(): Promise<{ content: string }> {
    throw new Error("MCP client not implemented in M1");
  }
}
