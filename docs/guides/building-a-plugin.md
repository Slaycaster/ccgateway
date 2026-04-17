# Building a Plugin

How to create a custom gateway plugin for ccgateway.

## The interface

Every plugin implements `CcgPlugin`:

```typescript
interface CcgPlugin {
  name: string;
  type: 'gateway' | 'skill' | 'tool';
  init(core: CcgCore): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

## Minimal example

A gateway plugin that reads from stdin (for illustration):

```typescript
import { CcgPlugin, CcgCore } from 'ccgateway';

export class StdinGateway implements CcgPlugin {
  name = 'stdin-gateway';
  type = 'gateway' as const;
  private core!: CcgCore;

  async init(core: CcgCore) {
    this.core = core;
  }

  async start() {
    process.stdin.on('data', async (data) => {
      const message = data.toString().trim();
      // Route the message through ccgateway
      await this.core.route({
        agent: 'myagent',
        source: 'stdin',
        sourceId: 'default',
        content: message,
        author: 'user',
      });
    });
  }

  async stop() {
    process.stdin.removeAllListeners('data');
  }
}
```

## What `CcgCore` provides

The `core` object passed to `init` gives you access to:

- **Routing** — Send messages through the standard pipeline (session → context → claude → response)
- **Session management** — Read/write session history
- **Agent config** — Look up agent details and bindings
- **Response handling** — Register callbacks for when agents respond

## Plugin registration

Plugins are registered in `config.json`:

```json
{
  "plugins": [
    {
      "name": "my-custom-gateway",
      "enabled": true,
      "config": {
        "customOption": "value"
      }
    }
  ]
}
```

## Tips

- Handle connection failures gracefully — gateways should reconnect automatically
- Respect `allowedUsers` if your gateway has a concept of user identity
- Use the `stop()` hook to clean up connections and listeners
- Look at the built-in Discord and Slack plugins in `src/plugins/` for reference implementations
