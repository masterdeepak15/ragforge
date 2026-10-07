# RAGForge

A self-hosted knowledge base for your documents. Upload files, ask questions and get cited answers, and let Claude Code, Claude Desktop, Cursor or any MCP client search the same knowledge base. This package installs it and gives you a `ragforge` command to set it up and run it.

![ragforge setup in a terminal](https://raw.githubusercontent.com/masterdeepak15/ragforge/main/assets/cli-setup.png)

Needs Node.js 20 or newer. Optional: [Docker](https://docs.docker.com/get-docker/), to run a local AI (Ollama) with no accounts or API keys.

## Install

```bash
npm install -g @masterdeepak15/ragforge
ragforge setup
```

`ragforge setup` asks where to keep your data, which database file to use, which port, and whether to run a local AI. Press Enter to accept each suggestion. It then starts RAGForge and prints the address (<http://localhost:8080>). The first visit creates your admin account.

By default everything lives in `~/.ragforge` (settings, uploaded files, the database). Each location can be changed during setup.

## Local AI with Docker and Ollama

If Docker is installed and running, setup can start Ollama in a container and download `nomic-embed-text` (for indexing) and a chat model sized to your computer. It shows the download size and asks first. Models are stored in your data folder. If Docker is missing, setup says so and lets you use an Ollama you already run, or add OpenAI or Gemini later in the app.

## Commands

| Command | What it does |
|---|---|
| `ragforge setup` | Guided setup (safe to run again) |
| `ragforge start` / `stop` / `restart` | Run it in the background (`stop --all` also stops Ollama) |
| `ragforge status` | What is running, where, and where your data is |
| `ragforge logs` | The log (`-n 100`, `-f` to follow) |
| `ragforge open` | Open it in your browser |
| `ragforge doctor` | Check everything and say how to fix problems |
| `ragforge mcp add claude-code\|claude-desktop\|cursor` | Connect an AI tool to your knowledge bases |
| `ragforge mcp remove <tool>` / `snippet <tool>` | Disconnect / print the settings to paste |
| `ragforge service install` / `uninstall` / `status` | Start RAGForge when you log in |
| `ragforge uninstall` | Stop it and remove its container and autostart; **keeps your data** |
| `ragforge uninstall --data` | Also delete your data, database and settings (asks you to type `delete`) |

Without questions: `ragforge setup --yes --ollama docker --data-dir D:\RagData --port 8080`. Options: `--port`, `--host`, `--data-dir`, `--db-path`, `--models-dir`, `--ollama docker|external|none`, `--ollama-url`, `--ollama-port`, `--chat-model`, `--no-start`.

## Connect an AI tool

```bash
ragforge mcp add claude-code
ragforge mcp add claude-desktop      # then restart Claude Desktop
ragforge mcp add cursor --kb Handbook
```

This creates an API key and writes the tool's configuration, keeping your other settings (a backup is made first). Add `--dry-run` to see what would change.

## Start with your computer

`ragforge service install` starts RAGForge when you log in: a per-user login entry on Windows (no administrator rights), a launch agent on macOS, a systemd user service on Linux.

## Safe by default

RAGForge listens on this computer only. Setup generates a random login secret and an encryption key for stored provider credentials and keeps them in `~/.ragforge/config.json`; back that file up with your data. `ragforge uninstall --data` refuses folders RAGForge did not create and never deletes your home folder.

Full documentation: <https://github.com/masterdeepak15/ragforge>

MIT licensed.
