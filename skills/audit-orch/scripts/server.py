import json
import os
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

PORT = 15788
MAX_TAIL_BYTES = 256 * 1024
MAX_TRANSCRIPT_BYTES = 192 * 1024
MAX_EVENTS = 120
JOB_ID_RE = re.compile(r"^(cc|agy|agy-probe)-[A-Za-z0-9_.-]+$")
TRANSCRIPT_CACHE = {}
PROCESS_CACHE = {"time": 0.0, "processes": [], "text": ""}


def find_orchestrator_dir(cwd):
    target = os.path.abspath(cwd)
    while target:
        check = os.path.join(target, ".agent-orchestrator")
        if os.path.isdir(check):
            return check
        parent = os.path.dirname(target)
        if parent == target:
            break
        target = parent
    return None


def safe_tail(path, max_bytes=MAX_TAIL_BYTES):
    if not path or not os.path.isfile(path):
        return ""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        if size > max_bytes:
            fh.seek(size - max_bytes)
        data = fh.read()
    return data.decode("utf-8", errors="replace")


def safe_run_path(orchestrator_dir, job_id):
    if not JOB_ID_RE.match(job_id or ""):
        raise ValueError("Invalid job id")
    runs_root = os.path.abspath(os.path.join(orchestrator_dir, "runs"))
    run_path = os.path.abspath(os.path.join(runs_root, job_id))
    if os.path.commonpath([runs_root, run_path]) != runs_root:
        raise ValueError("Job path escapes runs directory")
    return run_path


def project_name_for_claude(workspace_path):
    if not workspace_path:
        return ""
    return re.sub(r"[^A-Za-z0-9]+", "-", os.path.abspath(workspace_path)).strip("-")


def find_live_claude_transcripts(job):
    root = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    if not os.path.isdir(root):
        return []
    workspace = (job.get("workspace") or {}).get("path")
    session_id = job.get("session_id")
    job_id = job.get("id", "")
    cached = TRANSCRIPT_CACHE.get(job_id)
    if cached and os.path.exists(cached):
        return [cached]
    workspace_key = project_name_for_claude(workspace).lower()
    matches = []
    for folder_name in os.listdir(root):
        folder = os.path.join(root, folder_name)
        if not os.path.isdir(folder):
            continue
        lower = folder_name.lower()
        if job_id.lower() not in lower and (workspace_key and workspace_key not in lower):
            continue
        for file_name in os.listdir(folder):
            if not file_name.endswith(".jsonl"):
                continue
            if session_id and session_id not in file_name:
                continue
            full = os.path.join(folder, file_name)
            try:
                matches.append((os.path.getmtime(full), full))
            except OSError:
                pass
    matches.sort(reverse=True)
    paths = [path for _, path in matches]
    if paths:
        TRANSCRIPT_CACHE[job_id] = paths[0]
    return paths


def get_active_processes_snapshot():
    now = time.time()
    if now - PROCESS_CACHE["time"] < 1.0:
        return PROCESS_CACHE["processes"], PROCESS_CACHE["text"]
    ps_cmd = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { ($_.Name -eq 'claude.exe') -or ($_.Name -eq 'agy.exe') "
        "-or ($_.CommandLine -match 'agent-orch\\.ps1|agent-orch\\.mjs|claude -p|agy --print|Main\\.py|run_revision') } | "
        "Select-Object ProcessId, Name, CommandLine | ConvertTo-Json"
    )
    processes = []
    try:
        res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], capture_output=True, text=True, timeout=8)
        if res.stdout.strip():
            processes = json.loads(res.stdout)
            if not isinstance(processes, list):
                processes = [processes]
    except Exception:
        processes = []
    text = "\n".join(str(p.get("CommandLine", "")) for p in processes if isinstance(p, dict))
    PROCESS_CACHE.update({"time": now, "processes": processes, "text": text})
    return processes, text


def summarize_json(value, limit=4000):
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return text if len(text) <= limit else text[:limit] + "...[truncated]"


def extract_text(content):
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text" and item.get("text"):
                    parts.append(str(item["text"]))
                elif item.get("type") == "tool_result":
                    parts.append(str(item.get("content", "")))
            elif isinstance(item, str):
                parts.append(item)
    return "\n".join(part for part in parts if part)


def parse_claude_transcript(text):
    events = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        timestamp = item.get("timestamp") or item.get("created_at") or ""
        message = item.get("message") if isinstance(item.get("message"), dict) else {}
        role = message.get("role") or item.get("type") or ""
        model = message.get("model") or item.get("model") or ""
        content = message.get("content")

        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                kind = part.get("type", "")
                if kind == "text" and part.get("text"):
                    events.append({"kind": "assistant_text", "role": role, "model": model, "timestamp": timestamp, "text": part["text"]})
                elif kind == "tool_use":
                    events.append({"kind": "tool_use", "role": role, "model": model, "timestamp": timestamp, "tool": part.get("name", "tool"), "text": summarize_json(part.get("input", {}))})
                elif kind == "tool_result":
                    events.append({"kind": "tool_result", "role": role, "model": model, "timestamp": timestamp, "tool": part.get("tool_use_id", "tool_result"), "is_error": bool(part.get("is_error")), "text": extract_text(part.get("content"))})
        else:
            text_part = extract_text(content)
            if text_part:
                events.append({"kind": "message", "role": role, "model": model, "timestamp": timestamp, "text": text_part})

        if isinstance(item.get("toolUseResult"), dict):
            events.append({"kind": "tool_result", "role": item.get("type", ""), "timestamp": timestamp, "is_error": bool(item["toolUseResult"].get("is_error")), "text": summarize_json(item["toolUseResult"])})
    return events[-MAX_EVENTS:]


def model_from_events(events):
    for event in reversed(events or []):
        if event.get("model"):
            return event["model"]
    return ""


def parse_agy_transcript(text):
    events = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        role = item.get("source") or item.get("role") or item.get("type") or ""
        content = item.get("content") or item.get("text") or item.get("message") or ""
        if content:
            events.append({"kind": "agy_message", "role": role, "timestamp": item.get("timestamp", ""), "text": str(content)})
    return events[-MAX_EVENTS:]


class DashboardAPIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        if path == "/" or path == "/index.html":
            self.serve_file("index.html", "text/html")
        elif path.startswith("/api/"):
            self.serve_api(path)
        else:
            self.send_error(404, "File Not Found")

    def serve_file(self, filename, content_type):
        file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
        if os.path.exists(file_path):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(file_path, "rb") as fh:
                self.wfile.write(fh.read())
        else:
            self.send_error(404, f"{filename} Not Found")

    def serve_api(self, path):
        orchestrator_dir = find_orchestrator_dir(os.getcwd())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            if path == "/api/status":
                response_data = self.get_status_data(orchestrator_dir)
            elif path == "/api/runs":
                response_data = self.get_runs_list(orchestrator_dir)
            elif path.startswith("/api/run/"):
                job_id = unquote(path[len("/api/run/"):])
                response_data = self.get_run_detail(orchestrator_dir, job_id)
            else:
                response_data = {"error": "Invalid API Endpoint"}
        except Exception as exc:
            response_data = {"error": str(exc)}

        self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode("utf-8"))

    def get_status_data(self, orchestrator_dir):
        processes, _ = get_active_processes_snapshot()
        return {"orchestrator_found": orchestrator_dir is not None, "orchestrator_dir": orchestrator_dir, "active_processes": processes}

    def job_has_live_process(self, job, process_text):
        needles = [job.get("id", ""), job.get("session_id", ""), ((job.get("workspace") or {}).get("path") or "")]
        needles = [n for n in needles if n]
        return any(needle and needle in process_text for needle in needles)

    def get_runs_list(self, orchestrator_dir):
        if not orchestrator_dir:
            return []
        runs_dir = os.path.join(orchestrator_dir, "runs")
        if not os.path.exists(runs_dir):
            return []

        run_folders = [f for f in os.listdir(runs_dir) if os.path.isdir(os.path.join(runs_dir, f))]
        run_folders.sort(reverse=True)
        _, process_text = get_active_processes_snapshot()

        runs_list = []
        for folder in run_folders[:30]:
            job_file = os.path.join(runs_dir, folder, "job.json")
            if not os.path.exists(job_file):
                continue
            try:
                with open(job_file, "r", encoding="utf-8") as fh:
                    job = json.load(fh)
                observed_model = job.get("observed_model") or job.get("model")
                if not observed_model and job.get("attempts"):
                    observed_model = job["attempts"][-1].get("observed_model")
                status = job.get("status", "unknown")
                if status == "running" and not self.job_has_live_process(job, process_text):
                    status = "stale-running"
                runs_list.append({
                    "job_id": job.get("id", folder),
                    "provider": job.get("provider", "cc"),
                    "type": job.get("type", ""),
                    "task_id": job.get("task_id", ""),
                    "status": status,
                    "phase": job.get("phase", ""),
                    "started_at": job.get("started_at"),
                    "finished_at": job.get("finished_at"),
                    "model": observed_model,
                })
            except Exception:
                pass
        return runs_list

    def get_run_detail(self, orchestrator_dir, job_id):
        if not orchestrator_dir:
            return {"error": "Orchestrator dir not found"}
        run_path = safe_run_path(orchestrator_dir, job_id)
        if not os.path.exists(run_path):
            return {"error": f"Job folder {job_id} not found"}

        detail = {}
        job_file = os.path.join(run_path, "job.json")
        if os.path.exists(job_file):
            with open(job_file, "r", encoding="utf-8") as fh:
                detail["job"] = json.load(fh)

        evidence_file = os.path.join(run_path, "evidence.json")
        if os.path.exists(evidence_file):
            with open(evidence_file, "r", encoding="utf-8") as fh:
                detail["evidence"] = json.load(fh)

        detail["stdout_log"] = safe_tail(os.path.join(run_path, "cc-round-0.stdout.log"))
        detail["stderr_log"] = safe_tail(os.path.join(run_path, "cc-round-0.stderr.log"))
        detail["debug_log"] = safe_tail(os.path.join(run_path, "cc-round-0.claude-debug.log"))
        detail["patch"] = safe_tail(os.path.join(run_path, "changes.patch"))

        job = detail.get("job", {})
        if job.get("provider") == "cc":
            transcript_paths = []
            copied = os.path.join(run_path, "cc-round-0.claude-transcript.jsonl")
            if os.path.exists(copied):
                transcript_paths.append(copied)
            transcript_paths.extend(find_live_claude_transcripts(job))
            seen = set()
            transcript_paths = [p for p in transcript_paths if not (p in seen or seen.add(p))]
            if transcript_paths:
                text = safe_tail(transcript_paths[0], MAX_TRANSCRIPT_BYTES)
                events = parse_claude_transcript(text)
                detail["transcript_path"] = transcript_paths[0]
                detail["transcript_raw"] = text
                detail["transcript_events"] = events
                detail["observed_model"] = model_from_events(events)

        if job.get("provider") == "agy":
            detail["agy_cli_log"] = safe_tail(os.path.join(run_path, "agy-investigate.cli.log")) or safe_tail(os.path.join(run_path, "agy-verify.cli.log"))
            detail["agy_stdout_log"] = safe_tail(os.path.join(run_path, "agy-investigate.stdout.log")) or safe_tail(os.path.join(run_path, "agy-verify.stdout.log"))
            detail["agy_stderr_log"] = safe_tail(os.path.join(run_path, "agy-investigate.stderr.log")) or safe_tail(os.path.join(run_path, "agy-verify.stderr.log"))
            session_id = job.get("session_id") or (detail.get("evidence") or {}).get("session_id")
            if session_id:
                agy_transcript = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "brain", session_id, ".system_generated", "logs", "transcript.jsonl")
                if os.path.exists(agy_transcript):
                    text = safe_tail(agy_transcript, MAX_TRANSCRIPT_BYTES)
                    detail["agy_transcript_path"] = agy_transcript
                    detail["agy_transcript_raw"] = text
                    detail["agy_transcript_events"] = parse_agy_transcript(text)

        worktree_path = (job.get("workspace") or {}).get("path")
        if worktree_path and os.path.exists(worktree_path):
            try:
                res = subprocess.run(["git", "status"], cwd=worktree_path, capture_output=True, text=True, timeout=10)
                detail["git_status"] = res.stdout
            except Exception:
                pass
        return detail


def run():
    server_address = ("", PORT)
    httpd = ThreadingHTTPServer(server_address, DashboardAPIHandler)
    print(f"Starting server on port {PORT}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("Server stopped.")


if __name__ == "__main__":
    run()
