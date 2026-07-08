import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PORT = 15788
SERVER_VERSION = "audit-orch-project-bound-v3"
MAX_TAIL_BYTES = 256 * 1024
MAX_TRANSCRIPT_BYTES = 192 * 1024
MAX_EVENTS = 120
MAX_PROMPT_CONTENT_BYTES = 160 * 1024
JOB_ID_RE = re.compile(r"^(cc|agy|agy-probe)-[A-Za-z0-9_.-]+$")
TRANSCRIPT_CACHE = {}
PROCESS_CACHE = {"time": 0.0, "processes": [], "text": ""}
CONCLUSION_LOCK = threading.Lock()
CONCLUSION_JOBS = {}
SERVER_PROJECT_DIR = None
SERVER_ORCHESTRATOR_DIR = None


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


def transcript_cache_key(job):
    workspace = (job.get("workspace") or {}).get("path") or ""
    return "|".join([
        job.get("project_dir") or "",
        job.get("id") or "",
        job.get("session_id") or "",
        workspace,
    ])


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


def compact_path_key(value):
    return re.sub(r"[^A-Za-z0-9]+", "", value or "").lower()


def find_live_claude_transcripts(job):
    root = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    if not os.path.isdir(root):
        return []
    workspace = (job.get("workspace") or {}).get("path")
    session_id = job.get("session_id")
    if not workspace and not session_id:
        return []
    cache_key = transcript_cache_key(job)
    cached = TRANSCRIPT_CACHE.get(cache_key)
    if cached and os.path.exists(cached):
        return [{"path": cached, "reason": "cached exact job association"}]
    workspace_key = project_name_for_claude(workspace).lower()
    compact_workspace_key = compact_path_key(workspace_key)
    matches = []
    for folder_name in os.listdir(root):
        folder = os.path.join(root, folder_name)
        if not os.path.isdir(folder):
            continue
        lower = folder_name.lower()
        compact_folder_key = compact_path_key(lower)
        if workspace_key and workspace_key not in lower and compact_workspace_key not in compact_folder_key:
            continue
        for file_name in os.listdir(folder):
            if not file_name.endswith(".jsonl"):
                continue
            if session_id and session_id not in file_name:
                continue
            if not session_id and not workspace_key:
                continue
            full = os.path.join(folder, file_name)
            try:
                reason = "session_id exact match" if session_id else "workspace folder match"
                matches.append((os.path.getmtime(full), full, reason))
            except OSError:
                pass
    matches.sort(reverse=True)
    paths = [{"path": path, "reason": reason} for _, path, reason in matches]
    if paths:
        TRANSCRIPT_CACHE[cache_key] = paths[0]["path"]
    return paths


def infer_live_claude_session_id(job):
    if job.get("session_id"):
        return job.get("session_id")
    project_dir = job.get("project_dir") or ""
    task_id = job.get("task_id") or ""
    workspace = (job.get("workspace") or {}).get("path") or ""
    needles = [n for n in [project_dir, task_id, workspace] if n]
    if not needles:
        return ""
    processes, _ = get_active_processes_snapshot()
    claude_session_ids = []
    for process in processes:
        if not isinstance(process, dict):
            continue
        cmd = str(process.get("CommandLine") or "")
        if "claude" not in cmd or "--session-id" not in cmd:
            continue
        match = re.search(r"--session-id\s+([A-Za-z0-9-]+)", cmd)
        if not match:
            continue
        claude_session_ids.append(match.group(1))
        if any(needle in cmd for needle in needles):
            return match.group(1)
    unique_session_ids = sorted(set(claude_session_ids))
    if len(unique_session_ids) == 1:
        return unique_session_ids[0]
    return ""


def same_path(left, right):
    if not left or not right:
        return False
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def stored_session_id(orchestrator_dir, job):
    sessions_file = os.path.join(orchestrator_dir, "state", "sessions.json")
    if not os.path.isfile(sessions_file):
        return ""
    try:
        with open(sessions_file, "r", encoding="utf-8") as fh:
            sessions = (json.load(fh) or {}).get("sessions", {})
    except Exception:
        return ""
    candidates = []
    for session in sessions.values():
        if not isinstance(session, dict):
            continue
        if session.get("provider") != job.get("provider"):
            continue
        if session.get("task_id") != job.get("task_id"):
            continue
        if job.get("project_dir") and not same_path(session.get("project_dir"), job.get("project_dir")):
            continue
        if session.get("session_id"):
            candidates.append(session)
    candidates.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return candidates[0].get("session_id", "") if candidates else ""


def display_process(process):
    name = str(process.get("Name") or "").lower()
    command = str(process.get("CommandLine") or "")
    lower = command.lower()
    if "powershell" not in name:
        return True
    if "get-ciminstance win32_process" in lower:
        return False
    if re.search(r"(?i)\s-(?:encoded)?command\s", command):
        return False
    if "agent-orch.ps1" not in lower:
        return False
    return bool(re.search(r"(?i)-File\s+(?:\"[^\"]*agent-orch\.ps1\"|\S*agent-orch\.ps1)", command))


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
    processes = [p for p in processes if isinstance(p, dict) and display_process(p)]
    text = "\n".join(str(p.get("CommandLine", "")) for p in processes)
    PROCESS_CACHE.update({"time": now, "processes": processes, "text": text})
    return processes, text


def utc_timestamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def conclusion_path(orchestrator_dir, job_id):
    root = os.path.join(orchestrator_dir, "audit-conclusions")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, f"{job_id}.json")


def read_conclusion(orchestrator_dir, job_id):
    with CONCLUSION_LOCK:
        active = dict(CONCLUSION_JOBS.get(job_id) or {})
    path = conclusion_path(orchestrator_dir, job_id)
    saved = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
        except Exception:
            saved = {"status": "failed", "error": "Conclusion result could not be read."}
    return active or saved or {"status": "idle"}


def load_project_config(orchestrator_dir):
    path = os.path.join(orchestrator_dir, "config.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def project_display_name(project_path):
    """Derive a human-readable display name from a project directory path."""
    if not project_path:
        return ""
    try:
        config_file = os.path.join(project_path, ".agent-orchestrator", "config.json")
        if os.path.isfile(config_file):
            with open(config_file, "r", encoding="utf-8-sig") as fh:
                cfg = json.load(fh)
            display = cfg.get("display_name") or cfg.get("name")
            if display:
                return str(display)
    except Exception:
        pass
    abs_path = os.path.abspath(project_path)
    return os.path.basename(abs_path) or abs_path


def normalize_project_path(value):
    if not value:
        return ""
    text = str(value)
    if text.startswith("\\\\?\\"):
        text = text[4:]
    return os.path.abspath(text)


def codex_state_projects(limit=200):
    """Read project paths from Codex Desktop's local thread state."""
    db_path = os.path.join(os.path.expanduser("~"), ".codex", "state_5.sqlite")
    if not os.path.isfile(db_path):
        return []
    projects = []
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
        try:
            rows = con.execute(
                "select cwd from threads where cwd is not null and cwd != '' "
                "order by coalesce(updated_at_ms, updated_at, created_at_ms, created_at) desc limit ?",
                (limit,),
            ).fetchall()
        finally:
            con.close()
    except Exception:
        return []
    seen = set()
    for (cwd,) in rows:
        path = normalize_project_path(cwd)
        if not path or not os.path.isdir(path):
            continue
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        projects.append(path)
    return projects


def scan_project_candidates(root, max_depth=4, max_dirs=1200):
    """Find likely Codex/Agent Orch project roots without walking the whole disk."""
    found = []
    if not root or not os.path.isdir(root):
        return found
    root = os.path.abspath(root)
    queue = [(root, 0)]
    visited = set()
    scanned = 0
    skip_names = {
        ".git", ".venv", "venv", "env", "node_modules", "__pycache__",
        ".agent-orchestrator", ".mypy_cache", ".pytest_cache", "dist", "build",
    }
    while queue and scanned < max_dirs:
        current, depth = queue.pop(0)
        key = os.path.normcase(current)
        if key in visited:
            continue
        visited.add(key)
        scanned += 1

        if os.path.isdir(os.path.join(current, ".agent-orchestrator")):
            found.append(current)

        if depth >= max_depth:
            continue
        try:
            entries = list(os.scandir(current))
        except (OSError, PermissionError):
            continue
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.name in skip_names or entry.name.startswith("$"):
                continue
            queue.append((entry.path, depth + 1))
    return found


def candidate_scan_roots(bound_project):
    home = os.path.expanduser("~")
    roots = []
    for candidate in [
        os.path.join(home, "Documents", "Codex"),
        os.path.join(home, "Documents", "Hermes Build"),
        os.path.join(home, "Documents", "antigravity"),
        os.path.dirname(bound_project or ""),
    ]:
        if candidate and os.path.isdir(candidate):
            roots.append(os.path.abspath(candidate))
    deduped = []
    seen = set()
    for root in roots:
        key = os.path.normcase(root)
        if key not in seen:
            seen.add(key)
            deduped.append(root)
    return deduped


def discover_projects():
    """Discover known Codex/Agent Orch projects from safe local sources.

    Sources, in order of priority:
      1. the server-bound project directory (always included)
      2. Codex Desktop thread cwd values from ~/.codex/state_5.sqlite
      3. parent directories containing .agent-orchestrator
      4. ~/.claude/projects/  (Claude Code project folders)
      5. bounded scans of common workspace folders for .agent-orchestrator
      6. recent Agent Orch job.json files that reference distinct project directories
    """
    seen = {}
    root = os.path.abspath(SERVER_PROJECT_DIR or os.getcwd())
    sources = []

    # 1. server-bound project
    sources.append(("server", root))

    # 2. Codex Desktop project/workspace roots
    for project_dir in codex_state_projects():
        sources.append(("codex_state", project_dir))

    # 3. walk up from root for .agent-orchestrator parents
    target = root
    while target:
        check = os.path.join(target, ".agent-orchestrator")
        if os.path.isdir(check) and os.path.abspath(target) != os.path.abspath(root):
            sources.append(("parent_orchestrator", target))
        parent = os.path.dirname(target)
        if parent == target:
            break
        target = parent

    # 4. ~/.claude/projects/
    cc_projects = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    if os.path.isdir(cc_projects):
        for folder_name in os.listdir(cc_projects):
            folder = os.path.join(cc_projects, folder_name)
            if not os.path.isdir(folder):
                continue
            for settings_name in ("settings.json", "settings.local.json"):
                settings_path = os.path.join(folder, settings_name)
                if not os.path.isfile(settings_path):
                    continue
                try:
                    with open(settings_path, "r", encoding="utf-8-sig") as fh:
                        settings = json.load(fh)
                    project_dir = settings.get("projectRoot") or settings.get("cwd")
                    if project_dir and os.path.isdir(project_dir):
                        sources.append(("claude_projects", normalize_project_path(project_dir)))
                    break
                except Exception:
                    pass

    # 5. bounded scans of common local workspace folders
    for scan_root in candidate_scan_roots(root):
        for project_dir in scan_project_candidates(scan_root):
            sources.append(("workspace_scan", os.path.abspath(project_dir)))

    # 6. recent job.json files referencing distinct project directories
    #    scan the server orchestrator dir, plus any parent orchestrator dirs found
    orchestrator_dirs = set()
    if SERVER_ORCHESTRATOR_DIR:
        orchestrator_dirs.add(SERVER_ORCHESTRATOR_DIR)
    for source_kind, source_path in sources:
        orch = os.path.join(source_path, ".agent-orchestrator")
        if os.path.isdir(orch):
            orchestrator_dirs.add(orch)

    for orch_dir in orchestrator_dirs:
        runs_root = os.path.join(orch_dir, "runs")
        if not os.path.isdir(runs_root):
            continue
        for run_folder in sorted(os.listdir(runs_root), reverse=True)[:20]:
            job_file = os.path.join(runs_root, run_folder, "job.json")
            if not os.path.isfile(job_file):
                continue
            try:
                with open(job_file, "r", encoding="utf-8-sig") as fh:
                    job = json.load(fh)
                pd = job.get("project_dir")
                if not pd:
                    continue
                pd = normalize_project_path(pd)
                if os.path.isdir(pd):
                    sources.append(("job_reference", pd))
            except Exception:
                pass

    # Deduplicate and build result list
    for source_kind, source_path in sources:
        key = os.path.normcase(os.path.abspath(source_path))
        if key in seen:
            # keep the first (highest-priority) source kind
            continue
        if not os.path.isdir(source_path):
            continue
        seen[key] = (source_kind, os.path.abspath(source_path))

    _, process_text = get_active_processes_snapshot()
    projects = [project_summary(abs_path, src, process_text) for src, abs_path in seen.values()]

    # sort: projects with orchestrator first, then by active/total jobs desc
    projects.sort(key=lambda p: (
        not p["has_orchestrator"],
        -p["active_jobs"],
        -p["total_jobs"],
        p["display_name"].lower(),
    ))
    return projects


def job_role(job):
    """Map job fields to a dashboard role: Planner, Executor, Reviewer, Accepter, Coordinator."""
    provider = job.get("provider", "")
    job_type = job.get("type", "")
    phase = job.get("phase", "")
    if provider == "agy" and ("verify" in job_type or "investigate" in job_type):
        return "reviewer"
    # Accepter: applied jobs checked before executor since applied CC jobs
    # still carry cc provider and cc_execute type
    if phase in ("applied", "applied_and_cleaned"):
        return "accepter"
    if provider in ("agy_write",) or (provider == "cc" and ("exec" in job_type or "cont" in job_type or "auto" in job_type)):
        return "executor"
    if provider == "codex":
        return "planner"
    return "coordinator"


def job_stage(job):
    """Map job phase/type to a lifecycle stage: plan, execute, review, repair, accept, cleanup."""
    text = str(job.get("phase") or job.get("type") or "")
    if "verify" in text or "review" in text or "investigate" in text:
        return "review"
    if "applied" in text or "accepted" in text:
        return "accept"
    if "repair" in text:
        return "repair"
    if "clean" in text:
        return "cleanup"
    if any(k in text for k in ("queue", "prepar", "execut", "ready", "fail", "complet", "session", "job")):
        return "execute"
    return "plan"


def project_summary(project_path, source="manual", process_text=None):
    abs_path = os.path.abspath(project_path)
    if not os.path.isdir(abs_path):
        raise ValueError(f"Project directory does not exist: {project_path}")
    if process_text is None:
        _, process_text = get_active_processes_snapshot()

    orch_dir = os.path.join(abs_path, ".agent-orchestrator")
    has_orchestrator = os.path.isdir(orch_dir)
    total_jobs = 0
    active_jobs = 0
    stale_jobs = 0
    review_blocked = 0
    provider_counts = {"cc": 0, "agy": 0, "agy_write": 0, "codex": 0}
    role_counts = {"planner": 0, "executor": 0, "reviewer": 0, "accepter": 0, "coordinator": 0}
    stage_counts = {"plan": 0, "execute": 0, "review": 0, "repair": 0, "accept": 0, "cleanup": 0}
    fallback_chains = []

    now_ts = time.time()
    STALE_SECONDS = 900  # 15 minutes

    if has_orchestrator:
        runs_dir = os.path.join(orch_dir, "runs")
        if os.path.isdir(runs_dir):
            for run_folder in os.listdir(runs_dir):
                job_file = os.path.join(runs_dir, run_folder, "job.json")
                if not os.path.isfile(job_file):
                    continue
                total_jobs += 1
                try:
                    with open(job_file, "r", encoding="utf-8-sig") as fh:
                        job = json.load(fh)
                    status = job.get("status", "unknown")

                    # Count by provider
                    provider = job.get("provider", "")
                    if provider in provider_counts:
                        provider_counts[provider] += 1
                    elif provider:
                        provider_counts[provider] = provider_counts.get(provider, 0) + 1

                    # Count by role
                    role = job_role(job)
                    role_counts[role] = role_counts.get(role, 0) + 1

                    # Count by stage
                    stage = job_stage(job)
                    stage_counts[stage] = stage_counts.get(stage, 0) + 1

                    # Review-gate status
                    if job.get("requires_agy_review") and not job.get("review_waiver") and status == "completed" and job.get("phase") == "ready_for_acceptance":
                        review_blocked += 1

                    if status in ("queued", "running"):
                        if status == "running":
                            needles = [
                                job.get("id", ""),
                                job.get("session_id", ""),
                                job.get("task_id", ""),
                                job.get("project_dir", ""),
                                ((job.get("workspace") or {}).get("path") or ""),
                            ]
                            needles = [n for n in needles if n]
                            has_live = any(needle and needle in process_text for needle in needles)
                            if not has_live:
                                # Check also for stale (no update > 15 min)
                                updated = job.get("updated_at", "")
                                if updated:
                                    try:
                                        updated_ts = time.mktime(time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S"))
                                        if now_ts - updated_ts > STALE_SECONDS:
                                            stale_jobs += 1
                                    except Exception:
                                        pass
                                continue
                        active_jobs += 1

                    # Track fallback chains
                    if job.get("auto_fallback_classifier"):
                        fallback_chains.append({
                            "job_id": job.get("id"),
                            "task_id": job.get("task_id"),
                            "provider": job.get("provider"),
                            "auto_route": job.get("auto_route"),
                            "classifier": job.get("auto_fallback_classifier"),
                            "reason": (job.get("auto_fallback_reason") or "")[:200],
                        })

                except Exception:
                    pass

    return {
        "path": abs_path,
        "display_name": project_display_name(abs_path),
        "has_orchestrator": has_orchestrator,
        "total_jobs": total_jobs,
        "active_jobs": active_jobs,
        "stale_jobs": stale_jobs,
        "review_blocked": review_blocked,
        "provider_counts": provider_counts,
        "role_counts": role_counts,
        "stage_counts": stage_counts,
        "fallback_chains": fallback_chains[:20],
        "source": source,
    }


def write_conclusion(orchestrator_dir, job_id, payload):
    path = conclusion_path(orchestrator_dir, job_id)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def resolve_agy_command(command):
    if not command:
        command = "agy"
    if os.path.dirname(command):
        return command
    found = shutil.which(command)
    if found:
        return found
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "agy", "bin", "agy.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "agy", "bin", "agy.cmd"),
        os.path.join(home, ".local", "bin", "agy.exe"),
        os.path.join(home, ".local", "bin", "agy.cmd"),
        os.path.join(os.environ.get("APPDATA", ""), "npm", "agy.cmd"),
        os.path.join(os.environ.get("APPDATA", ""), "npm", "agy.exe"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return command


def agy_process_env():
    env = os.environ.copy()
    home = os.path.expanduser("~")
    env.setdefault("USERPROFILE", home)
    env.setdefault("HOME", env.get("USERPROFILE") or home)
    env.setdefault("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
    env.setdefault("APPDATA", os.path.join(home, "AppData", "Roaming"))
    return env


def run_agy_process(command, args, cwd, timeout):
    cwd = cwd if cwd and os.path.isdir(cwd) else os.getcwd()
    env = agy_process_env()
    try:
        return subprocess.run(
            [command, *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout + 30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env=env,
        )
    except FileNotFoundError:
        if not os.path.isfile(command):
            raise
        ps_exe = shutil.which("powershell.exe") or shutil.which("powershell") or "powershell.exe"
        ps_command = "& { param($Exe, [string[]]$Rest) & $Exe @Rest }"
        return subprocess.run(
            [ps_exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_command, command, *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout + 30,
            env=env,
        )


def build_agy_conclusion_prompt(prompt_header, transcript_content, transcript_path):
    if transcript_content:
        prompt = f"{prompt_header}\n\nTranscript:\n\n{transcript_content}"
    else:
        prompt = (
            f"{prompt_header}\n\n"
            f"(Transcript file was not readable at {transcript_path or 'unknown path'}. "
            "Please note in the conclusion that the transcript could not be loaded.)"
        )
    return prompt


def write_agy_conclusion_input(orchestrator_dir, job_id, prompt):
    root = os.path.join(orchestrator_dir, "audit-conclusions", ".tmp")
    os.makedirs(root, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix=f"{job_id}-", dir=root)
    prompt_path = os.path.join(temp_dir, "conclusion-input.txt")
    with open(prompt_path, "w", encoding="utf-8") as fh:
        fh.write(prompt)
    return temp_dir, prompt_path


def run_conclusion(orchestrator_dir, job_id, transcript_path, run_path, project_dir):
    config = load_project_config(orchestrator_dir)
    cli = config.get("cli") or {}
    execution = config.get("execution") or {}
    models = config.get("models") or {}
    command = resolve_agy_command(cli.get("agy") or "agy")
    prefix = list(cli.get("agy_prefix_args") or [])
    model = ((models.get("agy") or {}).get("low")) or "Gemini 3.5 Flash"
    timeout = min(int(execution.get("agy_timeout_seconds") or 300), 600)

    # Read transcript content directly so AGY doesn't need to access the file path.
    transcript_content = ""
    if transcript_path and os.path.isfile(transcript_path):
        size = os.path.getsize(transcript_path)
        try:
            with open(transcript_path, "rb") as fh:
                if size > MAX_PROMPT_CONTENT_BYTES:
                    fh.seek(size - MAX_PROMPT_CONTENT_BYTES)
                raw = fh.read()
            # Strip UTF-8 BOM if present
            if raw.startswith(b"\xef\xbb\xbf"):
                raw = raw[3:]
            transcript_content = raw.decode("utf-8", errors="replace")
        except Exception:
            transcript_content = ""

    prompt_header = (
        "You are a summarizer. Read the Agent Orch conversation transcript below and produce a concise conclusion. "
        "Write the entire conclusion in Simplified Chinese (简体中文). Keep code identifiers, file paths, commands, model names, "
        "and other proper nouns unchanged when translation would reduce precision. Do not include an English version. "
        "Cover the goal, decisions, code or files changed, tools and tests, failures or blockers, cost-relevant observations, "
        "and recommended next action. Distinguish verified facts from inference. Do not modify files or external systems."
    )
    prompt = build_agy_conclusion_prompt(prompt_header, transcript_content, transcript_path)
    prompt_dir = None
    prompt_path = None

    prompt_dir, prompt_path = write_agy_conclusion_input(orchestrator_dir, job_id, prompt)
    print_prompt = (
        "Read only the UTF-8 text file at this path and follow its instructions exactly. "
        "Do not run shell commands, inspect git, modify files, or access any other path. "
        "Write the final answer in Simplified Chinese only. "
        f"File: {prompt_path}"
    )
    args = prefix + ["--print", print_prompt, "--print-timeout", f"{timeout}s", "--model", model, "--add-dir", prompt_dir]
    if not transcript_content:
        args.extend(["--new-project", "--add-dir", run_path])
    if cli.get("agy_sandbox", False):
        args.append("--sandbox")
    started_at = utc_timestamp()
    try:
        completed = run_agy_process(command, args, project_dir or run_path, timeout)
        output = (completed.stdout or "").strip()
        stderr_text = (completed.stderr or "").strip()

        # Detect permission / auth failures from AGY output
        auth_indicators = [
            "permission denied", "access denied", "not authorized",
            "authentication required", "login required", "please sign in",
            "credentials", "token expired", "forbidden",
            "权限不足", "认证失败", "未授权", "请登录",
        ]
        combined_output = (output + stderr_text).lower()
        is_auth_failure = any(indicator.lower() in combined_output for indicator in auth_indicators)

        if completed.returncode != 0:
            if is_auth_failure or "permission" in stderr_text.lower():
                error_msg = (
                    "AGY 权限或认证失败。请检查 AGY CLI 是否已登录，"
                    "以及项目信任配置是否正确。"
                    f"\n详细错误: {stderr_text or '未知错误'}"
                )
            else:
                error_msg = (
                    f"AGY 执行失败 (退出码 {completed.returncode})。"
                    f"\n详细错误: {stderr_text or '未知错误'}"
                )
        elif not output:
            error_msg = "AGY 未返回任何结论内容。可能的原因：模型无响应或请求超时。"
        elif is_auth_failure:
            error_msg = "AGY 返回内容中包含权限或认证错误。请检查 AGY CLI 配置。"
        else:
            error_msg = ""

        payload = {
            "status": "completed" if completed.returncode == 0 and output and not is_auth_failure else "failed",
            "job_id": job_id,
            "model": model,
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "conclusion": output,
            "error": error_msg,
        }
    except subprocess.TimeoutExpired:
        payload = {
            "status": "failed",
            "job_id": job_id,
            "model": model,
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "conclusion": "",
            "error": "AGY 结论生成超时。请检查 AGY CLI 是否正常运行，或尝试减少 transcript 大小。",
        }
    except FileNotFoundError:
        if os.path.isfile(command):
            error = f"AGY CLI 启动失败：已找到可执行文件 '{command}'，但系统无法启动它。请尝试在终端运行该路径，或重新登录 AGY。"
        else:
            error = f"找不到 AGY CLI 可执行文件 '{command}'。请确认 AGY 已安装并在系统 PATH 中。"
        payload = {
            "status": "failed",
            "job_id": job_id,
            "model": model,
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "conclusion": "",
            "error": error,
        }
    except Exception as exc:
        payload = {
            "status": "failed",
            "job_id": job_id,
            "model": model,
            "started_at": started_at,
            "finished_at": utc_timestamp(),
            "conclusion": "",
            "error": f"AGY 结论生成失败: {str(exc)}",
        }
    if prompt_dir:
        shutil.rmtree(prompt_dir, ignore_errors=True)
    write_conclusion(orchestrator_dir, job_id, payload)
    with CONCLUSION_LOCK:
        CONCLUSION_JOBS[job_id] = payload


def start_conclusion(orchestrator_dir, job_id, detail):
    transcript_path = detail.get("transcript_path") or detail.get("agy_transcript_path")
    if not transcript_path or not os.path.isfile(transcript_path):
        return {"status": "failed", "error": "No readable conversation transcript is associated with this job."}, 400
    with CONCLUSION_LOCK:
        current = CONCLUSION_JOBS.get(job_id) or {}
        if current.get("status") == "running":
            return current, 202
        state = {"status": "running", "job_id": job_id, "started_at": utc_timestamp()}
        CONCLUSION_JOBS[job_id] = state
    job = detail.get("job") or {}
    run_path = safe_run_path(orchestrator_dir, job_id)
    thread = threading.Thread(
        target=run_conclusion,
        args=(orchestrator_dir, job_id, transcript_path, run_path, job.get("project_dir")),
        daemon=True,
        name=f"audit-conclusion-{job_id}",
    )
    thread.start()
    return state, 202


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


def request_project_context(parsed_url):
    params = parse_qs(parsed_url.query)
    requested = (params.get("project") or [""])[0]
    if requested and os.path.isdir(requested):
        project_dir = os.path.abspath(requested)
    else:
        project_dir = os.path.abspath(SERVER_PROJECT_DIR or os.getcwd())
    return project_dir, find_orchestrator_dir(project_dir)


class DashboardAPIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        if path == "/" or path == "/index.html":
            self.serve_file("index.html", "text/html")
        elif path.startswith("/vendor/"):
            self.serve_vendor(path)
        elif path.startswith("/api/"):
            self.serve_api(parsed_url)
        else:
            self.send_error(404, "File Not Found")

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        project_dir, orchestrator_dir = request_project_context(parsed_url)
        try:
            if path.startswith("/api/conclusion/"):
                job_id = unquote(path[len("/api/conclusion/"):])
                detail = self.get_run_detail(orchestrator_dir, job_id)
                if detail.get("error"):
                    self.send_json(detail, 404)
                    return
                response_data, status = start_conclusion(orchestrator_dir, job_id, detail)
                self.send_json(response_data, status)
                return
            self.send_json({"error": "Invalid API Endpoint"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def send_json(self, payload, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def serve_file(self, filename, content_type):
        global SERVER_PROJECT_DIR, SERVER_ORCHESTRATOR_DIR
        parsed = urlparse(self.path)
        if parsed.query:
            params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            project_param = params.get("project")
            if project_param:
                decoded = unquote(project_param)
                if os.path.isdir(decoded):
                    SERVER_PROJECT_DIR = os.path.abspath(decoded)
                    SERVER_ORCHESTRATOR_DIR = find_orchestrator_dir(SERVER_PROJECT_DIR)
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

    def serve_vendor(self, path):
        # Strict allowlist - only these two files may be served from vendor/.
        allowed = {"marked.min.js", "purify.min.js"}
        name = path[len("/vendor/"):]
        # Reject anything that is not a simple file name in the allowlist.
        if name not in allowed:
            self.send_error(403, "Forbidden")
            return
        vendor_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
        file_path = os.path.join(vendor_dir, name)
        if not os.path.isfile(file_path):
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(file_path, "rb") as fh:
            self.wfile.write(fh.read())

    def serve_api(self, parsed_url):
        path = parsed_url.path
        project_dir, orchestrator_dir = request_project_context(parsed_url)
        try:
            if path == "/api/status":
                response_data = self.get_status_data(project_dir, orchestrator_dir)
            elif path == "/api/projects":
                projects_list = discover_projects()
                response_data = {
                    "projects": projects_list,
                    "current_project": project_dir,
                    "current_orchestrator": orchestrator_dir,
                }
            elif path == "/api/project-info":
                params = parse_qs(parsed_url.query)
                requested = (params.get("project") or [""])[0]
                if not requested:
                    raise ValueError("Project path is required.")
                response_data = project_summary(requested)
            elif path == "/api/runs":
                response_data = self.get_runs_list(orchestrator_dir)
            elif path.startswith("/api/conclusion/"):
                job_id = unquote(path[len("/api/conclusion/"):])
                safe_run_path(orchestrator_dir, job_id)
                response_data = read_conclusion(orchestrator_dir, job_id)
            elif path.startswith("/api/run/"):
                job_id = unquote(path[len("/api/run/"):])
                response_data = self.get_run_detail(orchestrator_dir, job_id)
            else:
                response_data = {"error": "Invalid API Endpoint"}
        except Exception as exc:
            response_data = {"error": str(exc)}
        self.send_json(response_data)

    def get_status_data(self, project_dir, orchestrator_dir):
        processes, _ = get_active_processes_snapshot()
        return {
            "server_version": SERVER_VERSION,
            "orchestrator_found": orchestrator_dir is not None,
            "orchestrator_dir": orchestrator_dir,
            "project_dir": project_dir,
            "active_processes": processes,
        }

    def job_has_live_process(self, job, process_text):
        needles = [
            job.get("id", ""),
            job.get("session_id", ""),
            job.get("task_id", ""),
            job.get("project_dir", ""),
            ((job.get("workspace") or {}).get("path") or ""),
        ]
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
                    "role": job_role(job),
                    "stage": job_stage(job),
                    "type": job.get("type", ""),
                    "task_id": job.get("task_id", ""),
                    "status": status,
                    "phase": job.get("phase", ""),
                    "started_at": job.get("started_at"),
                    "finished_at": job.get("finished_at"),
                    "model": observed_model,
                    "requires_agy_review": job.get("requires_agy_review", False),
                    "review_waiver": job.get("review_waiver", False),
                    "auto_route": job.get("auto_route"),
                    "auto_fallback_classifier": job.get("auto_fallback_classifier"),
                    "auto_fallback_reason": (job.get("auto_fallback_reason") or "")[:200],
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

        job_file = os.path.join(run_path, "job.json")
        detail = {}
        detail["orchestrator_dir"] = orchestrator_dir
        detail["job_json_path"] = job_file
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
        session_id = job.get("session_id") or stored_session_id(orchestrator_dir, job)
        if session_id and not job.get("session_id"):
            job = dict(job)
            job["session_id"] = session_id
            detail["job"] = job
            detail["session_source"] = "state/sessions.json"
        if job.get("provider") == "cc":
            inferred_session_id = infer_live_claude_session_id(job)
            if inferred_session_id and not job.get("session_id"):
                job = dict(job)
                job["session_id"] = inferred_session_id
                detail["job"]["session_id"] = inferred_session_id
                detail["inferred_session_id"] = inferred_session_id
                detail["session_source"] = "live Claude process"
            transcript_paths = []
            copied = os.path.join(run_path, "cc-round-0.claude-transcript.jsonl")
            if os.path.exists(copied):
                transcript_paths.append({"path": copied, "reason": "run directory transcript"})
            transcript_paths.extend(find_live_claude_transcripts(job))
            seen = set()
            transcript_paths = [p for p in transcript_paths if not (p["path"] in seen or seen.add(p["path"]))]
            if transcript_paths:
                selected = transcript_paths[0]
                text = safe_tail(selected["path"], MAX_TRANSCRIPT_BYTES)
                events = parse_claude_transcript(text)
                detail["transcript_path"] = selected["path"]
                detail["transcript_match_reason"] = selected["reason"]
                detail["transcript_raw"] = text
                detail["transcript_events"] = events
                detail["observed_model"] = model_from_events(events)
            else:
                detail["transcript_match_reason"] = "No run transcript or safely matched Claude transcript found."

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


def run(project_dir=None, port=PORT):
    global SERVER_PROJECT_DIR, SERVER_ORCHESTRATOR_DIR
    if project_dir:
        SERVER_PROJECT_DIR = os.path.abspath(project_dir)
    else:
        SERVER_PROJECT_DIR = os.getcwd()
    SERVER_ORCHESTRATOR_DIR = find_orchestrator_dir(SERVER_PROJECT_DIR)
    server_address = ("", port)
    httpd = ThreadingHTTPServer(server_address, DashboardAPIHandler)
    print(f"Starting server on port {port}...")
    print(f"Project dir: {SERVER_PROJECT_DIR}")
    print(f"Orchestrator dir: {SERVER_ORCHESTRATOR_DIR or '(not found)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("Server stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Agent Orch read-only dashboard")
    parser.add_argument("--project-dir", default=os.getcwd(), help="Project directory to bind this dashboard to.")
    parser.add_argument("--port", type=int, default=PORT, help="Port to serve the dashboard on.")
    args = parser.parse_args()
    run(project_dir=args.project_dir, port=args.port)
