# Symphony Integration Guide

Vibe Interface CLI is a **worker-node runtime**. Symphony is the orchestrator.
Symphony dispatches work to Vibe; Vibe never polls Symphony.

---

## Contract

```
Symphony
  → vibe run start   → returns RunRecord JSON (run_id, status: running)
  → vibe run stream  → JSONL event stream until terminal state
  → vibe run status  → current RunRecord JSON
  → vibe run stop    → kill run, emit stopped event
```

---

## Shell Integration

```bash
# 1. Start a run
result=$(vibe run start \
  --agent claude-code \
  --repo-url https://github.com/org/repo \
  --branch main \
  --workspace-key ISSUE-123 \
  --prompt-file /tmp/task.txt)

run_id=$(echo "$result" | jq -r .run_id)
echo "started: $run_id"

# 2. Stream events until terminal state
vibe run stream "$run_id" | while IFS= read -r line; do
  type=$(echo "$line" | jq -r .type)
  echo "[event] $type"
  case "$type" in
    approval_required)
      msg=$(echo "$line" | jq -r '.data.message')
      echo "[approval needed] $msg"
      # Symphony handles approval decision here (MVP 5: vibe run approve)
      ;;
    completed)
      echo "[done] exit_code=$(echo "$line" | jq -r '.data.exit_code')"
      break
      ;;
    failed|stopped)
      echo "[terminal] $type"
      break
      ;;
  esac
done

# 3. Final status
vibe run status "$run_id"
```

---

## JSONL Event Types

| type | when | data fields |
|------|------|-------------|
| `session_started` | agent process launched | — |
| `output` | log line from agent | `text` |
| `status_change` | internal state transition | `status` |
| `approval_required` | agent needs a decision | `message` |
| `completed` | run finished successfully | `exit_code` |
| `failed` | run exited with error | `exit_code` |
| `stopped` | run was stopped via `vibe run stop` | — |

Terminal events: `completed`, `failed`, `stopped` — stream ends after any of these.

---

## RunRecord JSON

```json
{
  "run_id": "run_m0abc1_f3a9b2",
  "session_id": "mock_run_m0abc1_f3a9b2",
  "node_id": "local",
  "agent": "claude-code",
  "status": "running",
  "workspace_path": "/home/user/.vibe/workspaces/ISSUE-123",
  "repo_url": "https://github.com/org/repo",
  "branch": "main",
  "prompt_file": "/tmp/task.txt",
  "created_at": "2026-06-01T10:00:00.000Z",
  "updated_at": "2026-06-01T10:00:01.000Z"
}
```

---

## Environment Variables

| variable | default | description |
|----------|---------|-------------|
| `VIBE_WORKSPACE_ROOT` | `~/.vibe/workspaces` | root directory for all workspaces |
| `VIBE_NODE_ID` | `local` | node identifier in run records |

---

## Roadmap

| command | MVP |
|---------|-----|
| `vibe run start/stream/status/stop` | 0 (mock), 1 (claude-code) |
| `vibe node pair/daemon` | 3 (remote node) |
| `vibe run approve/deny` | 5 (approval flow) |
| `vibe run continue` | 5 |
