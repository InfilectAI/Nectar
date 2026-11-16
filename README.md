# Nectar

<p align="left">
  <img src="public/logo.svg" alt="Nectar Logo" width="56" height="56" />
</p>

**Distill hours of raw meetings into cited essentials and temporal memory.**

Nectar is a macOS meeting notepad and background memory companion. Jot down rough bullets during a call while Nectar captures speaker-attributed audio with zero Screen Recording permissions, enhances your notes into structured summaries, and exposes your meeting history and temporal memory to coding and desktop agents via a built-in local MCP server.

---

## Features

- **Zero-Screen-Recording Meeting Capture** — Automatically detects active Google Meet, Zoom, and Microsoft Teams calls using macOS Accessibility and CoreAudio Process Tap (`macOS 14.2+`), attributing speech to each participant in real time without screen-recording prompts.
- **Granola-Style Notepad & Enhancement** — Write freeform scratchpad bullets during the meeting, then click **Enhance Notes** to combine your rough notes with the speaker-attributed transcript into structured summaries, decisions, and `@owner` action items.
- **Local & Cloud Modes (Per-Model Configuration)** — Switch between **Local** mode (100% on-device Apple Silicon via `@infilectai/cortex`) and **Cloud** mode, or configure separate OpenAI-compatible endpoints, models, and API keys for **STT**, **Speaker Diarization**, **LLM**, and **Embeddings**.
- **Built-in Local MCP Server** — Quietly ingests and consolidates meetings into a local SQLite temporal knowledge graph (`@infilectai/synapse`) in the background, serving coding and desktop agents over HTTP (`http://127.0.0.1:4577/mcp`) and stdio (`bin/nectar-mcp.js`).

---

## MCP Tools

Nectar's background MCP server exposes three focused tools for Claude Desktop, Cursor, VS Code, and custom agents:

| Tool | Description |
| --- | --- |
| `list_meetings` | List recorded meetings with IDs, titles, dates, participants, and action item counts. |
| `get_meeting` | Retrieve the rough scratchpad notes, enhanced summary, action items, decisions, and speaker transcript for a meeting. |
| `find_memory` | Search across all meetings for decisions, ownership, blockers, or past discussions, returning cited answers alongside active and superseded historical facts. |

### Claude Desktop / Cursor Configuration

Copy directly from **Settings → Local MCP Server** in the app, or add:

```json
{
  "mcpServers": {
    "nectar": {
      "command": "node",
      "args": ["/path/to/Nectar/bin/nectar-mcp.js"]
    }
  }
}
```

---

## Getting Started

### Requirements

- **macOS 14.2+** (Apple Silicon `arm64`)
- **Node.js 22.5+**

### Install

Download `Nectar-<version>-arm64.dmg` from [Releases](https://github.com/InfilectAI/Nectar/releases) and drag Nectar to Applications. The app is ad-hoc signed and not notarized by Apple, so the first launch is blocked: open **System Settings → Privacy & Security** and choose **Open Anyway**.

### Run Locally

```bash
npm install
npm start
```

### Build

```bash
npm run build
```

---

## Built On

[Aira (`@infilectai/aira`)](https://www.npmjs.com/package/@infilectai/aira) | [Cortex (`@infilectai/cortex`)](https://www.npmjs.com/package/@infilectai/cortex) | [Synapse (`@infilectai/synapse`)](https://www.npmjs.com/package/@infilectai/synapse)

## License

MIT

