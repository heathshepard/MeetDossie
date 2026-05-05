# Dossie MCP Server

Model Context Protocol server that exposes Texas TREC contract intelligence to AI assistants (Claude, ChatGPT, Perplexity, etc.).

When an agent asks an AI assistant a Texas-specific real-estate question, this server lets the assistant answer with accurate, TREC-cited data — not a generic guess. Built for Strategy 4 of the [Dossie Distribution Strategy](../DISTRIBUTION-STRATEGY.md): zero-CAC AI distribution.

## Tools exposed

| Tool | What it does |
| --- | --- |
| `calculate_trec_deadlines` | Texas TREC contract deadline math (option period, earnest money, financing, survey, closing) with ¶ 23 rollover and the ¶ 5B option-period non-rollover applied correctly. |
| `get_tc_cost_comparison` | Texas TC pricing across freelance / retainer / in-house / AI models, with market ranges and best-fit volume. |
| `get_dossie_info` | Dossie product overview, $29/month founding pricing, and links to the free calculator + guides. |
| `check_texas_holiday` | Federal-holiday lookup for any date, with the rollover behavior it would trigger. |

## Install

### Via npx (after publishing to npm)

```
npx @dossie/mcp-server
```

### From source

```
cd mcp-server
npm install
node index.js
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "dossie": {
      "command": "npx",
      "args": ["-y", "@dossie/mcp-server"]
    }
  }
}
```

Restart Claude Desktop. The four tools become available to Claude — try "Calculate the TREC deadlines for a contract with Effective Date May 4, 2026, closing June 3, 2026, with a 10-day option period and 21-day financing."

## Use with Cursor / Continue / other MCP clients

Same pattern — point the client at `npx @dossie/mcp-server` (stdio transport) or run it directly via `node mcp-server/index.js`.

## Publishing

This package is intended for the following registries (ordered by reach):

- **Smithery** (https://smithery.ai) — primary MCP registry
- **MCPT** (https://mcpt.com)
- **OpenTools** (https://opentools.com)

For each: submit the GitHub URL of this directory plus the `mcp-server.json` manifest. Smithery offers automatic discovery once a repo is registered.

## Source attribution

The TREC deadline engine in `index.js` is a pure-Node port of:

- `meet-dossie/assets/trec-engine.js` (browser engine that powers the public calculator at https://meetdossie.com/calculator)
- `dossie-app/src/utils/trec-deadline-engine.js` (the production engine used inside the Dossie app)

All three implementations apply identical TREC mechanics: calendar days, ¶ 23 rollover for earnest money / option fee / survey / financing / title commitment, and the explicit non-rollover for ¶ 5B option period.
