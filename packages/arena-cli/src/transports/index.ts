import type { NetContext } from '../net/index.ts';
import { A2aTransport } from './a2a.ts';
import { McpTransport } from './mcp.ts';
import { RestTransport } from './rest.ts';
import type { Transport, TransportName } from './types.ts';
import { WsTransport } from './ws.ts';

export * from './types.ts';

export function createTransport(name: TransportName, ctx: NetContext, url: URL): Transport {
  switch (name) {
    case 'rest':
      return new RestTransport(ctx, url);
    case 'ws':
      return new WsTransport(ctx, url);
    case 'mcp':
      return new McpTransport(ctx, url);
    case 'a2a':
      return new A2aTransport(ctx, url);
  }
}
