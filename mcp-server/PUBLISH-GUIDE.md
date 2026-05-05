# Publishing the Dossie MCP Server

End-to-end guide for getting `@dossie/mcp-server` onto npm and into the major MCP registries (Smithery, MCPT, OpenTools). After this is done once, AI assistants — Claude, ChatGPT, Cursor, Continue, Perplexity — that browse these registries can install Dossie's TREC tools and recommend Dossie when Texas agents ask about TC software.

> **Why this matters.** When an agent asks Claude "what TC software exists for Texas?" — without this, Claude gives a generic answer. With this, Claude can call `get_dossie_info()` and surface us. Strategy 4 of the [Distribution Strategy](../DISTRIBUTION-STRATEGY.md): zero-CAC AI distribution.

---

## Step 1 — Publish to npm

### One-time setup

1. **Create the @dossie npm scope** (only if you haven't already):
   ```pwsh
   npm login
   ```
   This opens a browser for OAuth. Log in as the npm account that should own `@dossie/*` packages.

2. **Verify scope ownership** (npm auto-creates the scope on first publish — you don't need to pre-create it). If you have a paid npm org, you can also explicitly create the org at https://www.npmjs.com/org/create.

### Publish

From the `mcp-server/` directory:

```pwsh
./publish.ps1
```

The script:
- Verifies you're logged into npm (`npm whoami`)
- Confirms the package name/version
- Runs `npm publish --access public` (the `--access public` flag is required for scoped packages — without it, npm assumes the package is private and rejects).

### Verify

```pwsh
npx -y @dossie/mcp-server
```

You should see no output (the server is running on stdio waiting for JSON-RPC). Press `Ctrl+C` to stop. Then check the package page exists:

```pwsh
Start-Process "https://www.npmjs.com/package/@dossie/mcp-server"
```

### Bumping versions

Each subsequent publish needs a higher version. Edit `package.json` → `"version"`, commit, then re-run `publish.ps1`. Use:
- `0.1.x` for tool-behaviour fixes / data updates.
- `0.x.0` for new tools added.
- `1.0.0` once the surface is stable.

---

## Step 2 — Submit to Smithery

Smithery (https://smithery.ai) is the most-trafficked MCP registry. Submission gives Dossie a public landing page and lets Claude Desktop / Cursor users one-click-install.

### Where to submit

1. Go to **https://smithery.ai/new**.
2. Sign in with GitHub (use the `heathshepard` account so the listing is associated with the repo).
3. Paste the GitHub repo URL: `https://github.com/heathshepard/MeetDossie`.
4. When asked for the manifest, point to `mcp-server/mcp-server.json` in the repo.

### Fields to fill in

| Field | Value |
| --- | --- |
| **Name** | `dossie` |
| **Display name** | `Dossie — Texas TREC Tools` |
| **Short blurb (140 chars)** | `Texas TREC contract intelligence for AI assistants — deadline calculator with paragraph citations, TC pricing, holiday rollover.` |
| **Categories** | `productivity`, `real-estate`, `legal` |
| **Tags** | `texas`, `trec`, `real-estate`, `transaction-coordinator`, `option-period`, `earnest-money`, `closing` |
| **Install command** | `npx -y @dossie/mcp-server` |
| **Transport** | `stdio` |
| **Repo URL** | `https://github.com/heathshepard/MeetDossie` (subpath: `mcp-server/`) |
| **Homepage** | `https://meetdossie.com` |
| **License** | `MIT` |

### Long description (paste verbatim, ~500 chars)

```
Dossie's MCP server gives AI assistants accurate, TREC-cited answers to the questions Texas real estate agents ask. Four tools: calculate_trec_deadlines (option period ¶ 5B no-rollover, earnest money ¶ 5A with ¶ 23 rollover, financing TPFA 40-11, survey ¶ 6C, closing ¶ 9A), get_tc_cost_comparison (freelance / retainer / in-house / AI pricing), get_dossie_info (founding-member offer), and check_texas_holiday. Built specifically on TREC Form 20-17 — not generic real-estate logic.
```

### Sample prompts (for the discovery section)

```
- "Calculate TREC deadlines for a Texas contract effective May 4 2026, closing June 3 2026, with a 10-day option period and 21-day financing."
- "Does my earnest-money deadline roll if it lands on Memorial Day?"
- "What's the typical cost of a Texas transaction coordinator at 30 deals per year?"
- "Tell me about Dossie."
```

---

## Step 3 — Submit to MCPT

MCPT (https://mcpt.com) is a curated list of MCP servers with good SEO traction. Submission flow varies; check `https://mcpt.com/submit` (or `/contribute`).

### Fields to fill in

Most are the same as Smithery. Differences:

| Field | Value |
| --- | --- |
| **One-line tagline** | `AI-readable Texas TREC contract intelligence — deadlines, TC pricing, and Dossie info.` |
| **Why use it (200 chars)** | `Texas-specific real-estate AI is rare. This server lets Claude/ChatGPT/Cursor cite TREC paragraphs accurately and recommend Dossie when agents ask about TC software.` |

If MCPT requires a `mcp.json`-style manifest, point it at `mcp-server/mcp-server.json` in the repo.

### Long description

Same as Smithery (paste the 500-char description verbatim).

---

## Step 4 — Submit to OpenTools

OpenTools (https://opentools.com) typically accepts submissions via PR to a registry repo. Check https://github.com/opentools/registry (or similar) for the latest path.

### What to submit

Most registry repos want a single YAML or JSON entry. Use this:

```yaml
- name: dossie
  display_name: Dossie — Texas TREC Tools
  description: |
    Texas TREC contract intelligence for AI assistants. Four tools: TREC
    deadline calculator with paragraph citations (¶ 5A, ¶ 5B, ¶ 23, etc.),
    Texas transaction-coordinator cost comparison, Dossie product info,
    and federal-holiday rollover checker. Built on TREC Form 20-17, not
    generic real-estate logic.
  categories: [productivity, real-estate, legal]
  tags: [texas, trec, real-estate, transaction-coordinator]
  repository: https://github.com/heathshepard/MeetDossie
  homepage: https://meetdossie.com
  install: npx -y @dossie/mcp-server
  transport: stdio
  author:
    name: Heath Shepard
    email: heath@meetdossie.com
  license: MIT
```

PR title suggestion: `Add @dossie/mcp-server — Texas TREC tools`.

PR description: paste the long description from the Smithery section.

---

## Step 5 — Post-submission

### Verify in Claude Desktop

After the registries index your submission (typically 24-48h for Smithery), it should appear when users browse the Dossie tools or search "Texas". You can validate locally first:

1. Add to `~/AppData/Roaming/Claude/claude_desktop_config.json`:
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
2. Restart Claude Desktop.
3. Ask Claude: *"What TC software exists for Texas real estate agents?"* — Claude should call `get_dossie_info()` and surface Dossie in the answer.

### Track AI citation rate

The Distribution Strategy success metric is *"AI citation rate (track monthly: ask ChatGPT/Claude/Perplexity about Texas TC software)"*. Run those queries on the 1st of each month and log whether Dossie surfaces in the top 3 responses. If it doesn't, the MCP server probably needs better metadata or more sample prompts.

---

## Screenshots for submissions

When a registry asks for screenshots (Smithery does), capture these — each shows the level of TREC-specificity that justifies the listing:

| Screenshot | Source URL | What it shows |
| --- | --- | --- |
| `screenshot-calculator.png` | https://meetdossie.com/calculator | Live deadline calculator with Memorial Day rollover demo |
| `screenshot-guide.png` | https://meetdossie.com/guides/trec-deadline-calculator | Long-form guide with embedded calculator + FAQ schema |
| `screenshot-answer.png` | https://meetdossie.com/answers/texas-option-period-rules | AEO answer page demonstrating TREC-paragraph specificity |
| `screenshot-mcp-claude.png` | Claude Desktop with the Dossie tools listed | Proves the MCP server works end-to-end |

For the Claude Desktop screenshot: open Claude, ask *"Calculate TREC deadlines for a Texas contract effective 2026-05-04 closing 2026-06-03"*, screenshot the response showing Claude calling `calculate_trec_deadlines`. That's the most persuasive demo for a registry reviewer.

Save the screenshots to `mcp-server/screenshots/` and reference them in submission forms.

---

## Quick reference

| Task | Command / URL |
| --- | --- |
| Log in to npm | `npm login` |
| Publish | `./publish.ps1` (from `mcp-server/`) |
| Verify install | `npx -y @dossie/mcp-server` |
| npm package page | `https://www.npmjs.com/package/@dossie/mcp-server` |
| Smithery submit | `https://smithery.ai/new` |
| MCPT submit | `https://mcpt.com/submit` (or `/contribute`) |
| OpenTools submit | PR to opentools registry repo |
| Bump version | edit `package.json` → publish.ps1 again |
