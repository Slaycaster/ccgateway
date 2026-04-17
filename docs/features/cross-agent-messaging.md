# Cross-Agent Messaging

Agents can send messages to other agents through their gateway channels.

## How it works

When Salt sends a message to Pepper:

1. Salt calls `ccg send pepper "message" --from salt`
2. ccgateway looks up Pepper's channel binding
3. The message is posted to Pepper's Discord/Slack channel using Salt's bot token
4. Pepper's gateway picks it up like any other incoming message
5. Pepper processes and responds in her own channel

The message appears in Pepper's channel with Salt's bot avatar — it's indistinguishable from a direct Discord/Slack message.

## Usage

```bash
# From CLI
ccg send pepper "RCA done for NHD-10763" --from salt

# Agents can also call this from within their sessions
ccg send basil "Can you check the deploy logs?" --from pepper
```

## File-based inbox fallback

If an agent doesn't have a gateway binding (no Discord/Slack channel), messages fall back to a file-based inbox:

```bash
ccg send myagent "Check this out" --direct
```

The message is written to the agent's inbox file and picked up on their next invocation.

## Messaging policies

Cross-agent messaging is powerful but can get noisy. Consider adding communication rules to your agents' identity files to control when they should (and shouldn't) message other agents. See the [cross-agent comms skill](../reference/config.md) for an example policy.
