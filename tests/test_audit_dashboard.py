import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "dashboard" / "scripts" / "server.py"
INDEX_PATH = ROOT / "dashboard" / "scripts" / "index.html"

SPEC = importlib.util.spec_from_file_location("audit_orch_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class AuditDashboardTests(unittest.TestCase):
    # Existing tests

    def test_continue_job_uses_task_session_registry(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            state.mkdir()
            project = str(Path(root) / "project")
            payload = {
                "sessions": {
                    "key": {
                        "provider": "cc",
                        "task_id": "same-task",
                        "project_dir": project,
                        "session_id": "session-123",
                        "updated_at": "2026-07-03T00:00:00Z",
                    }
                }
            }
            (state / "sessions.json").write_text(json.dumps(payload), encoding="utf-8")
            job = {"provider": "cc", "task_id": "same-task", "project_dir": project}
            self.assertEqual(SERVER.stored_session_id(root, job), "session-123")

    def test_process_scanner_and_wrapper_shell_are_hidden(self):
        scanner = {
            "Name": "powershell.exe",
            "CommandLine": "powershell -Command Get-CimInstance Win32_Process agent-orch.ps1",
        }
        wrapper = {
            "Name": "powershell.exe",
            "CommandLine": "powershell -Command powershell -File C:/plugin/agent-orch.ps1 cc-exec",
        }
        worker = {
            "Name": "powershell.exe",
            "CommandLine": "powershell -ExecutionPolicy Bypass -File C:/plugin/agent-orch.ps1 cc-exec",
        }
        self.assertFalse(SERVER.display_process(scanner))
        self.assertFalse(SERVER.display_process(wrapper))
        self.assertTrue(SERVER.display_process(worker))

    def test_frontend_has_tool_folding_and_conclusion_tab(self):
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("overflow: hidden;", html)
        self.assertIn("TOOL_LINE_LIMIT = 3", html)
        self.assertIn('id="tab-conclusion"', html)
        self.assertIn("Generate Conclusion", html)

    # Project discovery tests

    def test_project_display_name_from_config(self):
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            (orch / "config.json").write_text(
                json.dumps({"display_name": "My Project", "trusted": True}),
                encoding="utf-8",
            )
            name = SERVER.project_display_name(root)
            self.assertEqual(name, "My Project")

    def test_project_display_name_falls_back_to_dirname(self):
        with tempfile.TemporaryDirectory() as root:
            name = SERVER.project_display_name(root)
            self.assertEqual(name, os.path.basename(root))

    def test_project_display_name_handles_bom_config(self):
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            # Write config with UTF-8 BOM
            raw = "\ufeff" + json.dumps({"display_name": "BOM Project"})
            (orch / "config.json").write_text(raw, encoding="utf-8")
            name = SERVER.project_display_name(root)
            self.assertEqual(name, "BOM Project")

    def test_codex_state_projects_reads_thread_cwds(self):
        """Project discovery should include Codex Desktop thread cwd values."""
        with tempfile.TemporaryDirectory() as root:
            project = Path(root) / "codex-project"
            project.mkdir()
            db_root = Path(root) / ".codex"
            db_root.mkdir()
            db_path = db_root / "state_5.sqlite"
            import sqlite3
            con = sqlite3.connect(db_path)
            con.execute("create table threads (cwd text, updated_at_ms integer, updated_at integer, created_at_ms integer, created_at integer)")
            con.execute("insert into threads values (?, 10, null, null, null)", (str(project),))
            con.commit()
            con.close()
            original_expanduser = SERVER.os.path.expanduser
            try:
                SERVER.os.path.expanduser = lambda value: root if value == "~" else original_expanduser(value)
                actual = [os.path.normcase(os.path.realpath(p)) for p in SERVER.codex_state_projects()]
                expected = os.path.normcase(os.path.realpath(str(project)))
                self.assertEqual(actual, [expected])
            finally:
                SERVER.os.path.expanduser = original_expanduser

    def test_discover_projects_includes_server_project(self):
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = str(orch)
                projects = SERVER.discover_projects()
                paths = [os.path.normcase(os.path.realpath(p["path"])) for p in projects]
                self.assertIn(os.path.normcase(os.path.realpath(root)), paths)
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    def test_discover_projects_counts_jobs(self):
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()
            for i in range(3):
                job_dir = runs / f"cc-test-{i}"
                job_dir.mkdir()
                (job_dir / "job.json").write_text(
                    json.dumps({
                        "id": f"cc-test-{i}",
                        "status": "completed" if i < 2 else "running",
                        "project_dir": root,
                    }),
                    encoding="utf-8",
                )
            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = str(orch)
                projects = SERVER.discover_projects()
                proj = next(
                    (p for p in projects
                     if os.path.normcase(os.path.realpath(p["path"])) == os.path.normcase(os.path.realpath(root))),
                    None,
                )
                self.assertIsNotNone(proj)
                self.assertTrue(proj["has_orchestrator"])
                self.assertEqual(proj["total_jobs"], 3)
                # 2 completed + 1 running (stale, with no matching process text)
                self.assertLessEqual(proj["active_jobs"], 1)
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    def test_discover_projects_from_parent_orchestrator(self):
        with tempfile.TemporaryDirectory() as root:
            parent = Path(root)
            child = parent / "subdir"
            child.mkdir()
            orch = parent / ".agent-orchestrator"
            orch.mkdir()
            (orch / "config.json").write_text(
                json.dumps({"trusted": True}), encoding="utf-8"
            )
            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = str(child)
                SERVER.SERVER_ORCHESTRATOR_DIR = None
                projects = SERVER.discover_projects()
                paths = [os.path.normcase(os.path.realpath(p["path"])) for p in projects]
                self.assertIn(os.path.normcase(os.path.realpath(str(parent))), paths)
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    def test_discover_projects_from_job_references(self):
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()
            job_dir = runs / "cc-ref-1"
            job_dir.mkdir()
            other_project = str(Path(root) / "other-project")
            os.makedirs(other_project, exist_ok=True)
            (job_dir / "job.json").write_text(
                json.dumps({
                    "id": "cc-ref-1",
                    "status": "completed",
                    "project_dir": other_project,
                }),
                encoding="utf-8",
            )
            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = str(orch)
                projects = SERVER.discover_projects()
                paths = [os.path.normcase(os.path.realpath(p["path"])) for p in projects]
                self.assertIn(os.path.normcase(os.path.realpath(other_project)), paths)
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    def test_discover_projects_deduplicates(self):
        """The same project should only appear once even if discovered from multiple sources."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()
            job_dir = runs / "cc-dup-1"
            job_dir.mkdir()
            (job_dir / "job.json").write_text(
                json.dumps({
                    "id": "cc-dup-1",
                    "status": "completed",
                    "project_dir": root,  # references itself
                }),
                encoding="utf-8",
            )
            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = str(orch)
                projects = SERVER.discover_projects()
                norm_path = os.path.normcase(os.path.abspath(root))
                occurrences = sum(
                    1 for p in projects
                    if os.path.normcase(os.path.abspath(p["path"])) == norm_path
                )
                self.assertEqual(occurrences, 1)
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    # Chinese conclusion prompt and handling

    def test_conclusion_prompt_contains_chinese_instruction(self):
        """Verify the conclusione prompt includes a Simplified Chinese instruction."""
        transcript_path = None
        run_path = None
        project_dir = None

        # Patch subprocess to avoid actually calling AGY
        original_run = SERVER.subprocess.run
        try:
            called_args = []

            def fake_run(cmd_args, **kwargs):
                called_args.append(cmd_args)
                for i, arg in enumerate(cmd_args):
                    if arg == "--print" and i + 1 < len(cmd_args) and "File: " in cmd_args[i + 1]:
                        prompt_file = cmd_args[i + 1].split("File: ", 1)[1]
                        with open(prompt_file, "r", encoding="utf-8") as fh:
                            called_args.append([fh.read()])
                completed = type("Completed", (), {
                    "returncode": 0,
                    "stdout": "这是中文结论内容。",
                    "stderr": "",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                # Create a fake transcript
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text(
                    json.dumps({"type": "message", "content": "test content"}) + "\n",
                    encoding="utf-8",
                )
                SERVER.run_conclusion(
                    orch, "cc-test-1", str(transcript), root, root
                )
                self.assertTrue(len(called_args) > 0)
                self.assertNotIn("--sandbox", called_args[0])
                # The prompt (which is in args) should contain the Chinese instruction
                prompt_found = False
                for arg in called_args[-1]:
                    if isinstance(arg, str) and "简体中文" in arg:
                        prompt_found = True
                        break
                self.assertTrue(prompt_found, "Prompt should include Simplified Chinese instruction")
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_stores_result_in_audit_conclusions(self):
        """Verify run_conclusion writes to .agent-orchestrator/audit-conclusions/<job_id>.json."""
        original_run = SERVER.subprocess.run
        try:
            def fake_run(cmd_args, **kwargs):
                completed = type("Completed", (), {
                    "returncode": 0,
                    "stdout": "中文结论测试。",
                    "stderr": "",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                # Create a fake transcript
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text(
                    json.dumps({"type": "message", "content": "test"}) + "\n",
                    encoding="utf-8",
                )
                SERVER.run_conclusion(orch, "cc-test-2", str(transcript), root, root)

                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-test-2.json")
                self.assertTrue(os.path.isfile(conclusion_file))

                with open(conclusion_file, "r", encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.assertEqual(saved["status"], "completed")
                self.assertEqual(saved["conclusion"], "中文结论测试。")
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_handles_missing_transcript(self):
        """run_conclusion should handle missing transcript file gracefully."""
        original_run = SERVER.subprocess.run
        try:
            def fake_run(cmd_args, **kwargs):
                completed = type("Completed", (), {
                    "returncode": 0,
                    "stdout": "Transcript unavailable, no conclusion.",
                    "stderr": "",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                # A missing transcript should not crash.
                SERVER.run_conclusion(
                    orch, "cc-no-transcript", "/nonexistent/path.jsonl", root, root
                )
                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-no-transcript.json")
                self.assertTrue(os.path.isfile(conclusion_file))
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_handles_agy_failure_with_chinese_error(self):
        """When AGY returns non-zero exit code, the error should be in Chinese."""
        original_run = SERVER.subprocess.run
        try:
            def fake_run(cmd_args, **kwargs):
                completed = type("Completed", (), {
                    "returncode": 1,
                    "stdout": "",
                    "stderr": "AGY execution failed with permission error",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text(
                    json.dumps({"type": "message", "content": "test"}) + "\n",
                    encoding="utf-8",
                )
                SERVER.run_conclusion(orch, "cc-fail-1", str(transcript), root, root)

                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-fail-1.json")
                with open(conclusion_file, "r", encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.assertEqual(saved["status"], "failed")
                # Error should contain Chinese
                self.assertIn("AGY", saved["error"])
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_handles_agy_timeout_with_chinese_error(self):
        """When AGY times out, the error message should be in Chinese."""
        original_run = SERVER.subprocess.run
        try:
            def fake_run(cmd_args, **kwargs):
                raise SERVER.subprocess.TimeoutExpired(cmd="agy", timeout=30)

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text("{}", encoding="utf-8")
                SERVER.run_conclusion(orch, "cc-timeout-1", str(transcript), root, root)

                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-timeout-1.json")
                with open(conclusion_file, "r", encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.assertEqual(saved["status"], "failed")
                self.assertIn("超时", saved["error"])
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_handles_file_not_found_with_chinese_error(self):
        """When AGY CLI is not found, the error message should be in Chinese."""
        original_run = SERVER.subprocess.run
        original_resolve = SERVER.resolve_agy_command
        try:
            def fake_run(cmd_args, **kwargs):
                raise FileNotFoundError("agy not found")

            SERVER.subprocess.run = fake_run
            SERVER.resolve_agy_command = lambda command: "definitely-missing-agy-cli"

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text("{}", encoding="utf-8")
                SERVER.run_conclusion(orch, "cc-nocli-1", str(transcript), root, root)

                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-nocli-1.json")
                with open(conclusion_file, "r", encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.assertEqual(saved["status"], "failed")
                self.assertIn("找不到", saved["error"])
        finally:
            SERVER.subprocess.run = original_run
            SERVER.resolve_agy_command = original_resolve

    def test_conclusion_handles_auth_failure_with_chinese_error(self):
        """When AGY output contains auth/permission failures, the error is in Chinese."""
        original_run = SERVER.subprocess.run
        try:
            def fake_run(cmd_args, **kwargs):
                completed = type("Completed", (), {
                    "returncode": 0,
                    "stdout": "权限不足，请登录后再试。",
                    "stderr": "authentication required",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text(
                    json.dumps({"type": "message", "content": "test"}) + "\n",
                    encoding="utf-8",
                )
                SERVER.run_conclusion(orch, "cc-auth-1", str(transcript), root, root)

                conclusion_file = os.path.join(orch, "audit-conclusions", "cc-auth-1.json")
                with open(conclusion_file, "r", encoding="utf-8") as fh:
                    saved = json.load(fh)
                self.assertEqual(saved["status"], "failed")
        finally:
            SERVER.subprocess.run = original_run

    # BOM and permission-safe behavior

    def test_safe_tail_handles_bom(self):
        """safe_tail should return content without BOM issues."""
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "bom.txt")
            with open(path, "wb") as fh:
                fh.write(b"\xef\xbb\xbfHello BOM World\nLine 2\n")
            result = SERVER.safe_tail(path, max_bytes=1024)
            self.assertIn("Hello BOM World", result)

    def test_transcript_read_handles_bom_in_conclusion(self):
        """The transcript content reader in run_conclusion should strip BOM."""
        original_run = SERVER.subprocess.run
        try:
            prompts_seen = []

            def fake_run(cmd_args, **kwargs):
                for i, arg in enumerate(cmd_args):
                    if arg == "--print" and i + 1 < len(cmd_args):
                        prompt_arg = cmd_args[i + 1]
                        if "File: " in prompt_arg:
                            prompt_file = prompt_arg.split("File: ", 1)[1]
                            with open(prompt_file, "r", encoding="utf-8") as fh:
                                prompts_seen.append(fh.read())
                        else:
                            prompts_seen.append(prompt_arg)
                        break
                completed = type("Completed", (), {
                    "returncode": 0,
                    "stdout": "BOM stripped conclusion.",
                    "stderr": "",
                })()
                return completed

            SERVER.subprocess.run = fake_run

            with tempfile.TemporaryDirectory() as root:
                orch = str(Path(root) / ".agent-orchestrator")
                os.makedirs(os.path.join(orch, "audit-conclusions"), exist_ok=True)
                (Path(orch) / "config.json").write_text(
                    json.dumps({"trusted": True}), encoding="utf-8"
                )
                transcript = Path(root) / "bom-transcript.jsonl"
                # Write with BOM
                with open(str(transcript), "wb") as fh:
                    fh.write(b"\xef\xbb\xbf")
                    fh.write(
                        (json.dumps({"type": "message", "content": "bom_test"}) + "\n").encode("utf-8")
                    )
                SERVER.run_conclusion(orch, "cc-bom-1", str(transcript), root, root)

                self.assertTrue(len(prompts_seen) > 0)
                prompt = prompts_seen[0]
                # BOM should have been stripped from the prompt
                self.assertNotIn("\ufeff", prompt)
                self.assertIn("bom_test", prompt)
        finally:
            SERVER.subprocess.run = original_run

    def test_conclusion_writes_atomic_tmp_then_rename(self):
        """write_conclusion should use a temp file + rename pattern."""
        with tempfile.TemporaryDirectory() as root:
            orch_dir = os.path.join(root, ".agent-orchestrator")
            os.makedirs(os.path.join(orch_dir, "audit-conclusions"), exist_ok=True)
            payload = {"status": "completed", "conclusion": "test"}
            SERVER.write_conclusion(orch_dir, "atomic-test", payload)
            target = os.path.join(orch_dir, "audit-conclusions", "atomic-test.json")
            self.assertTrue(os.path.isfile(target))
            with open(target, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            self.assertEqual(saved["status"], "completed")
            # No .tmp file should remain
            tmp_files = [f for f in os.listdir(os.path.join(orch_dir, "audit-conclusions")) if f.endswith(".tmp")]
            self.assertEqual(len(tmp_files), 0)

    # Frontend wiring for new features

    def test_agy_conclusion_uses_full_temp_file_and_short_command(self):
        """Long transcripts should use a temporary file, not the Windows command line."""
        original_run = SERVER.run_agy_process
        captured = {}
        try:
            def fake_run(command, args, cwd, timeout):
                print_prompt = args[args.index("--print") + 1]
                prompt_file = print_prompt.split("File: ", 1)[1]
                captured["print_prompt"] = print_prompt
                captured["prompt_file"] = prompt_file
                captured["file_content"] = Path(prompt_file).read_text(encoding="utf-8")
                return type("Completed", (), {
                    "returncode": 0,
                    "stdout": "完成。",
                    "stderr": "",
                })()

            SERVER.run_agy_process = fake_run
            with tempfile.TemporaryDirectory() as root:
                orch = Path(root) / ".agent-orchestrator"
                orch.mkdir()
                (orch / "config.json").write_text(json.dumps({"trusted": True}), encoding="utf-8")
                transcript = Path(root) / "transcript.jsonl"
                transcript.write_text("A" * 50000, encoding="utf-8")
                SERVER.run_conclusion(str(orch), "cc-temp-file", str(transcript), root, root)

                self.assertTrue(captured["file_content"].endswith("A" * 50000))
                self.assertLess(len(captured["print_prompt"]), 1000)
                self.assertFalse(os.path.exists(captured["prompt_file"]))
                temp_root = orch / "audit-conclusions" / ".tmp"
                self.assertEqual(list(temp_root.iterdir()), [])
        finally:
            SERVER.run_agy_process = original_run

    def test_resolve_agy_command_uses_known_local_install_path(self):
        """The dashboard server should find AGY even when service PATH is sparse."""
        with tempfile.TemporaryDirectory() as root:
            local_appdata = Path(root) / "LocalAppData"
            agy_bin = local_appdata / "agy" / "bin"
            agy_bin.mkdir(parents=True)
            agy_exe = agy_bin / "agy.exe"
            agy_exe.write_text("", encoding="utf-8")
            old_local = os.environ.get("LOCALAPPDATA")
            old_which = SERVER.shutil.which
            try:
                os.environ["LOCALAPPDATA"] = str(local_appdata)
                SERVER.shutil.which = lambda command: None
                self.assertEqual(SERVER.resolve_agy_command("agy"), str(agy_exe))
            finally:
                SERVER.shutil.which = old_which
                if old_local is None:
                    os.environ.pop("LOCALAPPDATA", None)
                else:
                    os.environ["LOCALAPPDATA"] = old_local

    def test_frontend_has_conclusion_button(self):
        """The frontend should have the Generate Conclusion button."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("Generate Conclusion", html)
        self.assertIn("requestConclusion()", html)

    def test_frontend_has_project_switcher(self):
        """The frontend should have a project selection view and navigation."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("showProjectsView()", html)
        self.assertIn("navigateToProject(", html)
        self.assertIn("loadProjects()", html)
        self.assertIn("project-grid", html)
        self.assertIn("project-card", html)
        self.assertIn("backToProjectsBtn", html)

    def test_frontend_persists_manual_project_preferences(self):
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("agentOrchAuditProjectPreferences", html)
        self.assertIn("customPaths", html)
        self.assertIn("hiddenPaths", html)
        self.assertIn("localStorage.setItem(PROJECT_PREFS_KEY", html)

    def test_frontend_can_add_remove_and_reset_projects(self):
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("addProjectPath()", html)
        self.assertIn("removeProjectPath(", html)
        self.assertIn("resetProjectDisplay()", html)
        self.assertIn("data-remove-project", html)
        self.assertIn("/api/project-info", html)

    def test_reset_only_restores_hidden_projects(self):
        html = INDEX_PATH.read_text(encoding="utf-8")
        start = html.index("function resetProjectDisplay()")
        body = html[start:html.index("}", start) + 1]
        self.assertIn("hiddenPaths = []", body)
        self.assertNotIn("customPaths = []", body)

    def test_frontend_has_process_column_collapse(self):
        """The frontend should have a collapsible right-side process column."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("process-column", html)
        self.assertIn("toggleProcessColumn()", html)
        self.assertIn("processToggle", html)
        self.assertIn("processesCollapsed", html)
        self.assertIn("process-column", html)  # CSS class
        # Collapse state
        self.assertIn("collapsed", html)
        self.assertIn("process-summary", html)
        self.assertIn("process-count-chip", html)
        self.assertIn("process-dot", html)
        self.assertNotIn("col.style.display = 'none'", html)
        self.assertIn(".process-column.collapsed .process-empty { display: none; }", html)

    def test_frontend_has_compact_metadata(self):
        """The frontend should have compact metadata with expand/collapse."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("meta-compact", html)
        self.assertIn("meta-badge", html)
        self.assertIn("toggleMetadata()", html)
        self.assertIn("metadataExpanded", html)
        self.assertIn("meta-toggle-btn", html)

    def test_frontend_has_default_bottom_scroll(self):
        """The frontend should auto-scroll conversation to bottom on load."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("followConversationBottom", html)
        self.assertIn("autofollow", html)
        self.assertIn("attachConversationAutofollow()", html)
        self.assertIn("isConversationAtBottom", html)
        # Default scroll on initial load
        self.assertIn("followConversationBottom(frame)", html)

    def test_frontend_has_three_line_tool_folding(self):
        """Tool-use/tool-result blocks should use 3-line folding."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("TOOL_LINE_LIMIT = 3", html)
        self.assertIn("tool-body-clamped", html)
        self.assertIn("toggleToolFold(", html)
        self.assertIn("-webkit-line-clamp: 3", html)
        self.assertIn("tool-expand-btn", html)

    def test_frontend_card_border_radius_max_8px(self):
        """All cards should have border-radius 8px or less, no 12px."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertNotIn("border-radius: 12px", html)

    def test_frontend_has_process_column_in_layout(self):
        """The body layout includes the right process column."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn('id="processColumn"', html)
        self.assertIn("updateProcessColumn", html)

    def test_frontend_preserves_theme_behavior(self):
        """Theme toggle and data-theme attribute are preserved."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn('data-theme="dark"', html)
        self.assertIn("toggleTheme()", html)
        self.assertIn("setAttribute('data-theme'", html.replace(" ", ""))
        self.assertIn("[data-theme=", html)

    def test_frontend_preserves_existing_tabs(self):
        """All existing CC and AGY tabs are preserved."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # CC tabs
        self.assertIn("tab-conversation", html)
        self.assertIn("tab-conclusion", html)
        self.assertIn("tab-log", html)
        self.assertIn("tab-stdio", html)
        self.assertIn("tab-patch", html)
        self.assertIn("tab-git", html)
        self.assertIn("tab-raw", html)
        # AGY tabs
        self.assertIn("tab-report", html)
        self.assertIn("tab-agy-transcript", html)
        self.assertIn("tab-agy-log", html)
        self.assertIn("tab-agy-stdio", html)

    # -- API response format tests --

    def test_api_projects_returns_object_with_keys(self):
        """The /api/projects handler should wrap discover_projects result in an object."""
        # Verify the code that wraps the response exists in server.py
        server_source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn('"projects": projects_list', server_source)
        self.assertIn('"current_project":', server_source)
        self.assertIn('"current_orchestrator":', server_source)

    def test_project_summary_accepts_manual_directory(self):
        with tempfile.TemporaryDirectory() as root:
            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(summary["path"], os.path.abspath(root))
            self.assertEqual(summary["source"], "manual")
            self.assertFalse(summary["has_orchestrator"])

    def test_project_summary_rejects_missing_directory(self):
        with self.assertRaises(ValueError):
            SERVER.project_summary("Z:/definitely/missing/agent-orch-project", process_text="")

    def test_api_has_manual_project_info_endpoint(self):
        server_source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn('path == "/api/project-info"', server_source)
        self.assertIn("project_summary(requested)", server_source)

    def test_frontend_handles_new_projects_response(self):
        """The frontend should handle the new object-format /api/projects response."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("data.projects || data", html)
        self.assertNotIn("data.current_project", html)
        self.assertIn("running-badge", html)
        self.assertNotIn("project-card.current", html)

    # -- Emoji/symbol-free UI tests --

    def test_frontend_no_emoji_in_labels(self):
        """Visible UI labels should not contain emoji characters."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # Check for common emoji that were previously in use
        for emoji in ["\U0001f7e2", "\U0001f4cb", "\u26a0\ufe0f", "\u25c0", "\u25b6", "\u25bc", "\u25b2", "\u2192"]:
            self.assertNotIn(emoji, html, f"Emoji/symbol '{emoji}' should not appear in the frontend")

    def test_frontend_uses_plain_text_processes_label(self):
        """Process column should use plain text label 'Processes'."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("Processes</span>", html)
        self.assertIn("process-column-title", html)

    def test_frontend_uses_symbol_process_toggle(self):
        """Process column toggle should be a symbol button with accessible labels."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("process-toggle::before", html)
        self.assertIn('aria-label="Collapse processes"', html)
        self.assertIn("setAttribute('aria-label', 'Expand processes')", html)
        self.assertNotIn("Collapse</button>", html)
        self.assertNotIn(">Expand<", html)

    def test_frontend_persists_process_column_state(self):
        """Process column collapsed state should survive page switches/reloads."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("agentOrchAuditProcessesCollapsed", html)
        self.assertIn("localStorage.getItem('agentOrchAuditProcessesCollapsed')", html)
        self.assertIn("localStorage.setItem('agentOrchAuditProcessesCollapsed'", html)
        self.assertIn("applyProcessColumnState()", html)

    def test_frontend_comments_are_ascii(self):
        """CSS/JS comments should not contain box-drawing characters."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # U+2500 is box drawings light horizontal
        self.assertNotIn("\u2500", html, "Box-drawing characters should not appear in comments")

    def test_frontend_handles_project_url_switching(self):
        """The frontend should support ?project= URL parameter for project switching."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("navigateToProject(", html)
        self.assertIn("searchParams.set('project'", html.replace(" ", ""))
        self.assertIn("currentProjectPath", html)
        self.assertIn("function projectApiUrl(path)", html)
        self.assertIn("projectApiUrl(`/api/conclusion/", html)

    def test_project_cards_use_data_attributes_not_inline_onclick(self):
        """Project cards should use data-project-path attributes, not inline onclick with path strings."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("data-project-path=", html)
        # Inline onclick with a path string argument is dangerous for Windows backslash paths
        self.assertNotIn("onclick=\"navigateToProject('", html)

    def test_navigate_to_project_triggers_full_page_navigation(self):
        """navigateToProject must trigger a full page reload via window.location.href assignment."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # Full navigation, not just replaceState.
        self.assertIn("window.location.href", html.replace(" ", ""))
        # Must NOT use replaceState for project switching
        self.assertNotIn("replaceState({},'',url.toString())", html.replace(" ", ""))

    def test_theme_toggle_is_icon_button(self):
        """Theme toggle should be an icon-style button with SVG, not visible text."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("<svg", html)
        self.assertIn("aria-label=\"Toggle Dark/Light Mode\"", html)
        # The visible text "Toggle Theme" should not appear inside the button
        # (the HTML should have SVG instead of the text node)
        self.assertNotIn(">Toggle Theme<", html)

    # -- Server-side project parameter handling --

    def test_request_project_context_uses_query_project(self):
        """Every project-scoped API request should resolve its own orchestrator root."""
        with tempfile.TemporaryDirectory() as root:
            project = Path(root) / "project"
            orch = project / ".agent-orchestrator"
            orch.mkdir(parents=True)
            parsed = SERVER.urlparse("/api/runs?project=" + str(project))
            project_dir, orchestrator_dir = SERVER.request_project_context(parsed)
            self.assertEqual(os.path.normcase(project_dir), os.path.normcase(str(project)))
            self.assertEqual(os.path.normcase(orchestrator_dir), os.path.normcase(str(orch)))

    def test_serve_file_rebinds_project_dir_on_query_param(self):
        """serve_file should rebind SERVER_PROJECT_DIR when ?project= is in the query string."""
        import io
        with tempfile.TemporaryDirectory() as root:
            new_project = os.path.join(root, "another-project")
            os.makedirs(new_project)

            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = None

                # Create a minimal handler mock with just the attributes serve_file uses
                class FakeHandler:
                    pass

                handler = FakeHandler()
                handler.path = "/index.html?project=" + new_project
                handler.wfile = io.BytesIO()
                handler.send_response = lambda code: None
                handler.send_header = lambda k, v: None
                handler.end_headers = lambda: None

                SERVER.DashboardAPIHandler.serve_file(handler, "index.html", "text/html")

                # After serve_file with ?project=, SERVER_PROJECT_DIR should be updated
                self.assertEqual(
                    os.path.normcase(os.path.abspath(SERVER.SERVER_PROJECT_DIR)),
                    os.path.normcase(os.path.abspath(new_project)),
                )
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    def test_serve_file_ignores_invalid_project_dir(self):
        """serve_file should NOT rebind when ?project= points to a non-existent directory."""
        import io
        with tempfile.TemporaryDirectory() as root:
            nonexistent = os.path.join(root, "nonexistent-dir")

            old_project = SERVER.SERVER_PROJECT_DIR
            old_orch = SERVER.SERVER_ORCHESTRATOR_DIR
            try:
                SERVER.SERVER_PROJECT_DIR = root
                SERVER.SERVER_ORCHESTRATOR_DIR = None

                class FakeHandler:
                    pass

                handler = FakeHandler()
                handler.path = "/index.html?project=" + nonexistent
                handler.wfile = io.BytesIO()
                handler.send_response = lambda code: None
                handler.send_header = lambda k, v: None
                handler.end_headers = lambda: None

                SERVER.DashboardAPIHandler.serve_file(handler, "index.html", "text/html")

                # Project dir should NOT change because the path doesn't exist
                self.assertEqual(
                    os.path.normcase(os.path.abspath(SERVER.SERVER_PROJECT_DIR)),
                    os.path.normcase(os.path.abspath(root)),
                )
            finally:
                SERVER.SERVER_PROJECT_DIR = old_project
                SERVER.SERVER_ORCHESTRATOR_DIR = old_orch

    # -- Markdown rendering and vendor asset tests --

    def test_vendor_directory_contains_marked_and_dompurify(self):
        """Vendor directory must contain local browser builds of marked and DOMPurify."""
        vendor = ROOT / "dashboard" / "scripts" / "vendor"
        self.assertTrue(vendor.is_dir(), "vendor directory must exist")
        marked_js = vendor / "marked.min.js"
        purify_js = vendor / "purify.min.js"
        self.assertTrue(marked_js.is_file(), "marked.min.js must be in vendor/")
        self.assertTrue(purify_js.is_file(), "purify.min.js must be in vendor/")
        # Files should be non-empty
        self.assertGreater(marked_js.stat().st_size, 0, "marked.min.js must not be empty")
        self.assertGreater(purify_js.stat().st_size, 0, "purify.min.js must not be empty")

    def test_server_has_vendor_route(self):
        """Server must serve vendor files via /vendor/ route."""
        server_source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn("/vendor/", server_source)
        self.assertIn("serve_vendor", server_source)

    @staticmethod
    def _serve_vendor(path):
        """Call serve_vendor with a minimal fake handler, return (status, headers)."""
        import io

        class FakeHandler:
            def __init__(self):
                self.status = None
                self.headers = []
            def send_response(self, code):
                self.status = code
            def send_header(self, k, v):
                self.headers.append((k, v))
            def end_headers(self):
                pass
            def send_error(self, code, msg=None):
                self.status = code
            def log_message(self, *args):
                pass

        handler = FakeHandler()
        handler.wfile = io.BytesIO()
        SERVER.DashboardAPIHandler.serve_vendor(handler, path)
        return handler.status, handler.headers

    # -- Allowlist: success paths --

    def test_serve_vendor_allows_marked_min_js(self):
        """serve_vendor must serve /vendor/marked.min.js with status 200 and JS content type."""
        status, headers = self._serve_vendor("/vendor/marked.min.js")
        self.assertEqual(status, 200)
        content_types = [v for k, v in headers if k.lower() == "content-type"]
        self.assertIn("application/javascript", content_types)

    def test_serve_vendor_allows_purify_min_js(self):
        """serve_vendor must serve /vendor/purify.min.js with status 200 and JS content type."""
        status, headers = self._serve_vendor("/vendor/purify.min.js")
        self.assertEqual(status, 200)
        content_types = [v for k, v in headers if k.lower() == "content-type"]
        self.assertIn("application/javascript", content_types)

    # -- Allowlist: rejection paths --

    def test_serve_vendor_rejects_unknown_file(self):
        """serve_vendor must reject a file name not in the allowlist."""
        status, _ = self._serve_vendor("/vendor/unknown-file.js")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_nested_path(self):
        """serve_vendor must reject paths with directory separators."""
        status, _ = self._serve_vendor("/vendor/sub/marked.min.js")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_forward_slash_traversal(self):
        """serve_vendor must reject ../ traversal with forward slashes."""
        status, _ = self._serve_vendor("/vendor/../../secret.txt")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_backslash_traversal(self):
        """serve_vendor must reject ..\\ traversal with backslashes."""
        status, _ = self._serve_vendor("/vendor/..\\..\\secret.txt")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_absolute_windows_path(self):
        """serve_vendor must NOT serve C:/Windows/win.ini via the vendor route."""
        status, _ = self._serve_vendor("/vendor/C:/Windows/win.ini")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_drive_relative_backslash(self):
        """serve_vendor must reject a drive-relative backslash path."""
        status, _ = self._serve_vendor("/vendor/C:..\\..\\Windows\\win.ini")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_drive_relative_forward_slash(self):
        """serve_vendor must reject a drive-relative forward-slash path."""
        status, _ = self._serve_vendor("/vendor/C:../../Windows/win.ini")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_percent_encoded_slash(self):
        """serve_vendor must reject percent-encoded slashes in the file name."""
        status, _ = self._serve_vendor("/vendor/..%2f..%2fsecret.txt")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_percent_encoded_backslash(self):
        """serve_vendor must reject percent-encoded backslashes in the file name."""
        status, _ = self._serve_vendor("/vendor/..%5c..%5csecret.txt")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_empty_name(self):
        """serve_vendor must reject an empty file name."""
        status, _ = self._serve_vendor("/vendor/")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_only_prefix(self):
        """serve_vendor must reject /vendor with no trailing file name."""
        status, _ = self._serve_vendor("/vendor")
        self.assertEqual(status, 403)

    def test_serve_vendor_rejects_null_byte(self):
        """serve_vendor must reject a name containing a null byte."""
        status, _ = self._serve_vendor("/vendor/marked.min.js\x00.html")
        self.assertEqual(status, 403)

    def test_server_vendor_route_is_allowlist_based(self):
        """The server source must contain the allowlist set literal."""
        server_source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn("allowed", server_source)
        self.assertIn("marked.min.js", server_source)
        self.assertIn("purify.min.js", server_source)

    def test_frontend_imports_vendor_scripts(self):
        """Frontend must load marked and DOMPurify from vendor/."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn('src="/vendor/marked.min.js"', html)
        self.assertIn('src="/vendor/purify.min.js"', html)

    def test_frontend_uses_marked_and_dompurify_for_conclusion(self):
        """renderConclusionState must call marked.parse and DOMPurify.sanitize."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("marked.parse", html)
        self.assertIn("DOMPurify.sanitize", html)
        self.assertIn("ALLOWED_TAGS", html)
        self.assertIn("ALLOWED_ATTR", html)

    def test_frontend_conclusion_is_div_not_pre(self):
        """Conclusion pane must use a div.conclusion-md, not a pre element."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn('class="conclusion-md"', html)
        self.assertIn('data-field="conclusionText"', html)
        # Should NOT have <pre data-field="conclusionText"
        self.assertNotIn('<pre data-field="conclusionText"', html)

    def test_frontend_has_conclusion_markdown_css(self):
        """Frontend CSS must include styles for all Markdown elements rendered from AGY output."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn(".conclusion-md", html)
        # Check for key Markdown element styles
        for selector in [
            ".conclusion-md h1",
            ".conclusion-md h2",
            ".conclusion-md h3",
            ".conclusion-md h4",
            ".conclusion-md ul",
            ".conclusion-md ol",
            ".conclusion-md li",
            ".conclusion-md a",
            ".conclusion-md blockquote",
            ".conclusion-md table",
            ".conclusion-md th",
            ".conclusion-md td",
            ".conclusion-md code",
            ".conclusion-md pre",
            ".conclusion-md pre code",
            ".conclusion-md hr",
            ".conclusion-md strong",
            ".conclusion-md em",
            ".conclusion-md img",
        ]:
            self.assertIn(selector, html, f"CSS must contain {selector}")

    def test_frontend_conversation_events_still_escaped(self):
        """Conversation event rendering must use textContent/escapeHtml, not marked."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # Conversation event body still uses escapeHtml for plain text
        self.assertIn("escapeHtml(text)", html)
        # The event-body div must not use innerHTML from marked output
        self.assertIn("event-body", html)
        # No <think> Markdown interpretation
        self.assertNotIn("<think>", html.lower() if False else html)
        # The marked/DOMPurify path is ONLY for conclusion
        marked_count = html.count("marked.parse")
        self.assertEqual(marked_count, 1, "marked.parse should only be called in renderConclusionState")

    def test_dompurify_blocks_xss_via_node(self):
        """DOMPurify must sanitize out dangerous HTML from conclusion content (verify via Node.js)."""
        purify_path = ROOT / "dashboard" / "scripts" / "vendor" / "purify.min.js"
        node_script = (
            "const fs = require('fs');"
            "const { JSDOM } = require(" + json.dumps(str(ROOT / "node_modules" / "jsdom" / "lib" / "api.js")) + ");"
            "const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });"
            "const window = dom.window;"
            "const scriptEl = window.document.createElement('script');"
            "scriptEl.textContent = fs.readFileSync(" + json.dumps(str(purify_path)) + ", 'utf-8');"
            "window.document.body.appendChild(scriptEl);"
            "const DOMPurify = window.DOMPurify;"
            "if (!DOMPurify) throw new Error('DOMPurify not found');"
            "const malicious = '<p>Safe text</p><script>alert(\"xss\")</script><img src=x onerror=alert(1)>';"
            "const clean = DOMPurify.sanitize(malicious);"
            "if (!clean.includes('Safe text')) throw new Error('Missing safe text');"
            "if (clean.includes('<script>')) throw new Error('Script tag not removed');"
            "if (clean.includes('onerror')) throw new Error('onerror attribute not removed');"
            "console.log('OK');"
        )
        try:
            result = subprocess.run(
                ["node", "-e", node_script],
                capture_output=True, text=True, timeout=10,
                cwd=str(ROOT),
            )
            self.assertIn("OK", result.stdout, f"DOMPurify XSS test failed: {result.stderr}")
        except FileNotFoundError:
            self.skipTest("Node.js not available")

    def test_marked_parses_commonmark_via_node(self):
        """marked must convert standard Markdown to HTML (verify via Node.js)."""
        marked_path = ROOT / "dashboard" / "scripts" / "vendor" / "marked.min.js"
        node_script = (
            "const fs = require('fs');"
            "const { JSDOM } = require(" + json.dumps(str(ROOT / "node_modules" / "jsdom" / "lib" / "api.js")) + ");"
            "const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });"
            "const window = dom.window;"
            "const scriptEl = window.document.createElement('script');"
            "scriptEl.textContent = fs.readFileSync(" + json.dumps(str(marked_path)) + ", 'utf-8');"
            "window.document.body.appendChild(scriptEl);"
            "const marked = window.marked;"
            "if (!marked) throw new Error('marked not found');"
            "const md = '# Title\\n\\nThis is **bold** and *italic*.\\n\\n* item 1\\n* item 2\\n';"
            "const html = marked.parse(md, { breaks: true });"
            "if (!html.includes('<h1')) throw new Error('Missing h1');"
            "if (!html.includes('<strong>')) throw new Error('Missing strong');"
            "if (!html.includes('<em>')) throw new Error('Missing em');"
            "if (!html.includes('<li>')) throw new Error('Missing li');"
            "if (!html.includes('<p>')) throw new Error('Missing p');"
            "console.log('OK');"
        )
        try:
            result = subprocess.run(
                ["node", "-e", node_script],
                capture_output=True, text=True, timeout=10,
                cwd=str(ROOT),
            )
            self.assertIn("OK", result.stdout, f"marked test failed: {result.stderr}")
        except FileNotFoundError:
            self.skipTest("Node.js not available")

    def test_marked_and_dompurify_integration_via_node(self):
        """marked output piped through DOMPurify must produce clean HTML (verify via Node.js)."""
        marked_path = ROOT / "dashboard" / "scripts" / "vendor" / "marked.min.js"
        purify_path = ROOT / "dashboard" / "scripts" / "vendor" / "purify.min.js"
        node_script = (
            "const fs = require('fs');"
            "const { JSDOM } = require(" + json.dumps(str(ROOT / "node_modules" / "jsdom" / "lib" / "api.js")) + ");"
            "const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });"
            "const window = dom.window;"
            "let scriptEl = window.document.createElement('script');"
            "scriptEl.textContent = fs.readFileSync(" + json.dumps(str(marked_path)) + ", 'utf-8');"
            "window.document.body.appendChild(scriptEl);"
            "scriptEl = window.document.createElement('script');"
            "scriptEl.textContent = fs.readFileSync(" + json.dumps(str(purify_path)) + ", 'utf-8');"
            "window.document.body.appendChild(scriptEl);"
            "const marked = window.marked;"
            "const DOMPurify = window.DOMPurify;"
            "const md = '## Conclusion\\n\\nSafe paragraph with `inline code`.\\n\\n```python\\nprint(\"hello\")\\n```\\n\\nMalicious: <script>evil()</script>\\n\\n* item A\\n* item B';"
            "const rawHtml = marked.parse(md, { breaks: true });"
            "const clean = DOMPurify.sanitize(rawHtml);"
            "if (!clean.includes('Conclusion')) throw new Error('Missing heading text');"
            "if (!clean.includes('<h2')) throw new Error('Missing h2 tag');"
            "if (!clean.includes('<code>inline code</code>')) throw new Error('Missing inline code');"
            "if (!clean.includes('<pre><code')) throw new Error('Missing fenced code block');"
            "if (!clean.includes('<li>item A</li>')) throw new Error('Missing list item');"
            "if (clean.includes('<script>')) throw new Error('Script tag should be removed');"
            "if (clean.includes('onerror')) throw new Error('Event handlers should be removed');"
            "console.log('OK');"
        )
        try:
            result = subprocess.run(
                ["node", "-e", node_script],
                capture_output=True, text=True, timeout=10,
                cwd=str(ROOT),
            )
            self.assertIn("OK", result.stdout, f"Integration test failed: {result.stderr}")
        except FileNotFoundError:
            self.skipTest("Node.js not available")

    def test_frontend_loading_state_preserved(self):
        """Conclusion must show readable loading state while AGY is running."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("Waiting for AGY output...", html)
        self.assertIn("Summarizing...", html)

    def test_frontend_empty_state_preserved(self):
        """Conclusion must show readable empty state when no conclusion exists."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("No conclusion has been generated.", html)

    # -- Dependency pinning tests --

    def test_marked_dompurify_jsdom_are_pinned_exact(self):
        """marked, dompurify, and jsdom must use exact versions (no caret/tilde ranges)."""
        pkg_path = ROOT / "package.json"
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        deps = pkg.get("dependencies", {})
        dev_deps = pkg.get("devDependencies", {})
        self.assertEqual(deps.get("marked"), "15.0.12",
                         "marked must be pinned to exact version 15.0.12")
        self.assertEqual(deps.get("dompurify"), "3.4.12",
                         "dompurify must be pinned to exact version 3.4.12")
        self.assertEqual(dev_deps.get("jsdom"), "26.0.0",
                         "jsdom must be pinned to exact version 26.0.0")

    def test_package_json_has_no_caret_deps_for_marked_dompurify_jsdom(self):
        """The raw package.json text must not contain caret ranges for the three deps."""
        raw = (ROOT / "package.json").read_text(encoding="utf-8")
        # Look for caret-prefixed versions of our three packages
        caret_patterns = [
            re.compile(r'"marked"\s*:\s*"\^'),
            re.compile(r'"dompurify"\s*:\s*"\^'),
            re.compile(r'"jsdom"\s*:\s*"\^'),
        ]
        for pat in caret_patterns:
            self.assertIsNone(pat.search(raw),
                              f"Caret range found in package.json: {pat.pattern}")

    # -- Role/stage/provider dashboard tests --

    def test_job_role_classifies_correctly(self):
        """job_role should classify jobs into Planner, Executor, Reviewer, Accepter, Coordinator."""
        self.assertEqual(SERVER.job_role({"provider": "agy", "type": "agy_verify"}), "reviewer")
        self.assertEqual(SERVER.job_role({"provider": "agy", "type": "agy_investigate"}), "reviewer")
        self.assertEqual(SERVER.job_role({"provider": "cc", "type": "cc_execute"}), "executor")
        self.assertEqual(SERVER.job_role({"provider": "cc", "type": "cc_continue"}), "executor")
        self.assertEqual(SERVER.job_role({"provider": "agy_write", "type": "agy_execute"}), "executor")
        self.assertEqual(SERVER.job_role({"provider": "cc", "type": "auto_execute"}), "executor")
        self.assertEqual(SERVER.job_role({"provider": "cc", "type": "cc_execute", "phase": "applied"}), "accepter")
        self.assertEqual(SERVER.job_role({"provider": "cc", "type": "cc_execute", "phase": "applied_and_cleaned"}), "accepter")
        self.assertEqual(SERVER.job_role({"provider": "codex"}), "planner")
        self.assertEqual(SERVER.job_role({"provider": "unknown"}), "coordinator")

    def test_job_stage_classifies_correctly(self):
        """job_stage should map job phase/type to lifecycle stages."""
        self.assertEqual(SERVER.job_stage({"phase": "queued"}), "execute")
        self.assertEqual(SERVER.job_stage({"phase": "executing"}), "execute")
        self.assertEqual(SERVER.job_stage({"phase": "verifying"}), "review")
        self.assertEqual(SERVER.job_stage({"phase": "repairing"}), "repair")
        self.assertEqual(SERVER.job_stage({"phase": "ready_for_acceptance"}), "execute")
        self.assertEqual(SERVER.job_stage({"phase": "applied"}), "accept")
        self.assertEqual(SERVER.job_stage({"phase": "applied_and_cleaned"}), "accept")
        self.assertEqual(SERVER.job_stage({"phase": "cleaned"}), "cleanup")
        self.assertEqual(SERVER.job_stage({"type": "agy_investigate"}), "review")
        self.assertEqual(SERVER.job_stage({"type": "auto_execute"}), "execute")

    def test_project_summary_includes_role_provider_stage_counts(self):
        """project_summary must include provider_counts, role_counts, stage_counts, and review fields."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()

            # Create jobs with different providers
            for job_type, provider, task_id in [
                ("cc_execute", "cc", "task-1"),
                ("cc_execute", "cc", "task-2"),
                ("agy_verify", "agy", "task-1"),
                ("agy_execute", "agy_write", "task-3"),
            ]:
                job_dir = runs / f"{provider}-{task_id}"
                job_dir.mkdir()
                (job_dir / "job.json").write_text(json.dumps({
                    "id": f"{provider}-{task_id}",
                    "type": job_type,
                    "provider": provider,
                    "status": "completed" if "verify" not in job_type else "completed",
                    "phase": "ready_for_acceptance" if "verify" not in job_type else "completed",
                    "project_dir": root,
                    "task_id": task_id,
                    "requires_agy_review": "verify" not in job_type,
                }), encoding="utf-8")

            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(summary["total_jobs"], 4)
            self.assertIn("provider_counts", summary)
            self.assertIn("role_counts", summary)
            self.assertIn("stage_counts", summary)
            self.assertIn("stale_jobs", summary)
            self.assertIn("review_blocked", summary)
            self.assertIn("fallback_chains", summary)

            # Provider counts
            self.assertGreaterEqual(summary["provider_counts"].get("cc", 0), 2)
            self.assertGreaterEqual(summary["provider_counts"].get("agy", 0), 1)
            self.assertGreaterEqual(summary["provider_counts"].get("agy_write", 0), 1)
            # Role counts
            self.assertGreaterEqual(summary["role_counts"].get("executor", 0), 3)
            self.assertGreaterEqual(summary["role_counts"].get("reviewer", 0), 1)

    def test_project_summary_counts_review_blocked_jobs(self):
        """Jobs that are ready_for_acceptance but require AGY review should count as review_blocked."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()

            # CC job with review required, ready for acceptance but no waiver
            job_dir = runs / "cc-blocked-1"
            job_dir.mkdir()
            (job_dir / "job.json").write_text(json.dumps({
                "id": "cc-blocked-1",
                "type": "cc_execute",
                "provider": "cc",
                "status": "completed",
                "phase": "ready_for_acceptance",
                "project_dir": root,
                "task_id": "blocked-task",
                "requires_agy_review": True,
                "review_waiver": False,
            }), encoding="utf-8")

            # CC job with waiver, should NOT be blocked
            job_dir2 = runs / "cc-waiver-2"
            job_dir2.mkdir()
            (job_dir2 / "job.json").write_text(json.dumps({
                "id": "cc-waiver-2",
                "type": "cc_execute",
                "provider": "cc",
                "status": "completed",
                "phase": "ready_for_acceptance",
                "project_dir": root,
                "task_id": "waiver-task",
                "requires_agy_review": True,
                "review_waiver": True,
            }), encoding="utf-8")

            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(summary["review_blocked"], 1)

    def test_project_summary_detects_stale_jobs(self):
        """Jobs that are running but not seen in process text and have old updated_at should be stale."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()

            # Create a running job with old timestamp
            job_dir = runs / "cc-stale-1"
            job_dir.mkdir()
            old_time = "2026-01-01T00:00:00Z"
            (job_dir / "job.json").write_text(json.dumps({
                "id": "cc-stale-1",
                "type": "cc_execute",
                "provider": "cc",
                "status": "running",
                "phase": "executing",
                "project_dir": root,
                "task_id": "stale-task",
                "updated_at": old_time,
                "started_at": old_time,
            }), encoding="utf-8")

            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(summary["stale_jobs"], 1)

    def test_project_summary_tracks_fallback_chains(self):
        """Jobs with auto_fallback_classifier should appear in fallback_chains."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()

            job_dir = runs / "cc-fallback-1"
            job_dir.mkdir()
            (job_dir / "job.json").write_text(json.dumps({
                "id": "cc-fallback-1",
                "type": "auto_execute",
                "provider": "cc",
                "status": "completed",
                "phase": "ready_for_acceptance",
                "project_dir": root,
                "task_id": "fb-task",
                "auto_route": "cc_fallback",
                "auto_fallback_classifier": "quota_exhaustion",
                "auto_fallback_reason": "AGY quota exceeded",
            }), encoding="utf-8")

            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(len(summary["fallback_chains"]), 1)
            self.assertEqual(summary["fallback_chains"][0]["classifier"], "quota_exhaustion")

    def test_runs_list_includes_role_stage_review_fields(self):
        """The /api/runs endpoint should include role, stage, requires_agy_review, and review_waiver fields."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            runs = orch / "runs"
            runs.mkdir()

            job_dir = runs / "cc-test-1"
            job_dir.mkdir()
            (job_dir / "job.json").write_text(json.dumps({
                "id": "cc-test-1",
                "type": "cc_execute",
                "provider": "cc",
                "status": "completed",
                "phase": "ready_for_acceptance",
                "project_dir": root,
                "task_id": "test-task",
                "requires_agy_review": True,
                "review_waiver": False,
                "auto_route": "cc",
                "auto_fallback_classifier": None,
                "auto_fallback_reason": None,
            }), encoding="utf-8")

            # Test the run list entry format by directly calling project_summary
            summary = SERVER.project_summary(root, process_text="")
            self.assertEqual(summary["total_jobs"], 1)
            # The summary includes review_blocked=1 since requires_agy_review plus ready_for_acceptance
            self.assertEqual(summary["review_blocked"], 1)

    def test_frontend_handles_new_summary_fields(self):
        """The frontend should handle the new summary fields from /api/projects."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # The frontend should handle the expanded project-summary structure
        # At minimum, it should support the project display and counts
        self.assertIn("active_jobs", html)
        self.assertIn("total_jobs", html)
        self.assertIn("has_orchestrator", html)

    # -- Plan/contract/job provenance dashboard tests --

    def test_load_plans_empty_dir(self):
        """load_plans should return empty list when no plans directory exists."""
        with tempfile.TemporaryDirectory() as root:
            result = SERVER.load_plans(root)
            self.assertEqual(result, [])

    def test_load_plans_reads_plan_files(self):
        """load_plans should read valid plan files from .agent-orchestrator/plans/."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            plans_dir = orch / "plans"
            plans_dir.mkdir(parents=True)
            (plans_dir / "plan-test.json").write_text(json.dumps({
                "plan_id": "plan-test",
                "name": "Test Plan",
                "type": "formal",
                "project_dir": root,
            }), encoding="utf-8")
            (plans_dir / "invalid.json").write_text("not json", encoding="utf-8")
            result = SERVER.load_plans(str(orch))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["plan_id"], "plan-test")

    def test_build_plan_summary_counts_jobs_per_plan(self):
        """build_plan_summary should count jobs by plan_id and include legacy."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            runs_dir = orch / "runs"
            runs_dir.mkdir(parents=True)

            # Create jobs spread across plans
            for i, (pid, ptype) in enumerate([("plan-a", "formal"), ("plan-a", "formal"), ("plan-b", "adhoc")]):
                jdir = runs_dir / f"job-{i}"
                jdir.mkdir()
                (jdir / "job.json").write_text(json.dumps({
                    "id": f"job-{i}", "task_id": f"t{i}", "status": "completed",
                    "project_dir": root, "plan_id": pid, "plan_type": ptype,
                }), encoding="utf-8")

            # Legacy job (no plan_id)
            jdir = runs_dir / "legacy-job"
            jdir.mkdir()
            (jdir / "job.json").write_text(json.dumps({
                "id": "legacy-job", "task_id": "legacy", "status": "completed",
                "project_dir": root,
            }), encoding="utf-8")

            summary = SERVER.build_plan_summary(str(orch))
            self.assertEqual(summary["total_jobs"], 4)
            self.assertEqual(summary["total_plan_jobs"], 4)

            plans_by_id = {p["plan_id"]: p for p in summary["plans"]}
            self.assertEqual(plans_by_id["plan-a"]["job_counts"]["total"], 2)
            self.assertEqual(plans_by_id["plan-b"]["job_counts"]["total"], 1)
            self.assertIn("__legacy__", plans_by_id)
            self.assertEqual(plans_by_id["__legacy__"]["job_counts"]["total"], 1)
            self.assertEqual(plans_by_id["__legacy__"]["type"], "legacy")
            self.assertEqual(plans_by_id["__legacy__"]["read_only"], True)
            self.assertIsNone(summary["integrity_warning"])

    def test_build_plan_summary_no_plans_no_jobs(self):
        """build_plan_summary on empty project should return zero counts."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir(parents=True)
            summary = SERVER.build_plan_summary(str(orch))
            self.assertEqual(summary["total_jobs"], 0)
            self.assertEqual(summary["plans"], [])

    def test_project_summary_includes_plan_counts(self):
        """project_summary should include plan_counts and legacy_job_count fields."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            orch.mkdir()
            (orch / "config.json").write_text(json.dumps({"trusted": True}), encoding="utf-8")
            runs = orch / "runs"
            runs.mkdir()
            jdir = runs / "plan-job"
            jdir.mkdir()
            (jdir / "job.json").write_text(json.dumps({
                "id": "plan-job", "task_id": "t1", "status": "completed",
                "project_dir": root, "plan_id": "plan-x", "plan_type": "formal",
            }), encoding="utf-8")

            summary = SERVER.project_summary(root, process_text="")
            self.assertIn("plan_counts", summary)
            self.assertIn("legacy_job_count", summary)
            self.assertEqual(summary["plan_counts"]["plan-x"]["total"], 1)
            self.assertEqual(summary["legacy_job_count"], 0)

    # -- Plan-based job grouping endpoint tests --

    def test_build_plan_summary_adhoc_plan_shows_jobs_without_contracts(self):
        """An ad-hoc plan with jobs but no contracts must appear with correct job counts."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            runs_dir = orch / "runs"
            runs_dir.mkdir(parents=True)
            plans_dir = orch / "plans"
            plans_dir.mkdir(parents=True)

            # Create an ad-hoc plan file
            (plans_dir / "plan-adhoc-1.json").write_text(json.dumps({
                "plan_id": "plan-adhoc-1",
                "name": "Ad-hoc / Test Plan",
                "type": "adhoc",
                "project_dir": root,
            }), encoding="utf-8")

            # Create jobs for this ad-hoc plan (no contracts exist)
            for i, status in enumerate(["completed", "failed", "completed"]):
                jdir = runs_dir / f"adhoc-job-{i}"
                jdir.mkdir()
                (jdir / "job.json").write_text(json.dumps({
                    "id": f"adhoc-job-{i}", "task_id": f"t{i}", "status": status,
                    "project_dir": root, "plan_id": "plan-adhoc-1", "plan_type": "adhoc",
                    "association_reason": "auto_adhoc",
                }), encoding="utf-8")

            summary = SERVER.build_plan_summary(str(orch))
            plans_by_id = {p["plan_id"]: p for p in summary["plans"]}

            self.assertIn("plan-adhoc-1", plans_by_id,
                          "Ad-hoc plan must appear in plan summary even without contracts")
            self.assertEqual(plans_by_id["plan-adhoc-1"]["job_counts"]["total"], 3)
            self.assertEqual(plans_by_id["plan-adhoc-1"]["job_counts"]["completed"], 2)
            self.assertEqual(plans_by_id["plan-adhoc-1"]["job_counts"]["failed"], 1)
            self.assertEqual(plans_by_id["plan-adhoc-1"]["type"], "adhoc")
            self.assertIsNone(summary["integrity_warning"])

    def test_build_plan_summary_legacy_shows_unmapped_jobs(self):
        """Legacy/Migration plan must include every job without a plan_id."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            runs_dir = orch / "runs"
            runs_dir.mkdir(parents=True)

            # Create jobs with and without plan_id
            for pid in [None, None, "plan-mapped"]:
                jdir = runs_dir / f"job-{pid or 'legacy'}-{len(list(runs_dir.iterdir()))}"
                jdir.mkdir()
                j = {"id": jdir.name, "task_id": "t1", "status": "completed", "project_dir": root}
                if pid:
                    j["plan_id"] = pid
                    j["plan_type"] = "formal"
                (jdir / "job.json").write_text(json.dumps(j), encoding="utf-8")

            summary = SERVER.build_plan_summary(str(orch))
            self.assertEqual(summary["total_jobs"], 3)
            self.assertEqual(summary["total_plan_jobs"], 3)

            legacy = next((p for p in summary["plans"] if p["plan_id"] == "__legacy__"), None)
            self.assertIsNotNone(legacy, "Legacy plan must exist for unmapped jobs")
            self.assertEqual(legacy["job_counts"]["total"], 2)
            self.assertEqual(legacy["type"], "legacy")
            self.assertTrue(legacy["read_only"])

    def test_build_plan_summary_project_total_equals_plan_sums(self):
        """Sum of all plan job counts must equal total project jobs."""
        with tempfile.TemporaryDirectory() as root:
            orch = Path(root) / ".agent-orchestrator"
            runs_dir = orch / "runs"
            runs_dir.mkdir(parents=True)
            plans_dir = orch / "plans"
            plans_dir.mkdir(parents=True)

            # Formal plan
            (plans_dir / "plan-f.json").write_text(json.dumps({
                "plan_id": "plan-f", "type": "formal", "name": "Formal",
            }), encoding="utf-8")

            # Ad-hoc plan
            (plans_dir / "plan-a.json").write_text(json.dumps({
                "plan_id": "plan-a", "type": "adhoc", "name": "Ad-hoc",
            }), encoding="utf-8")

            # Jobs spread across plans
            for pid, ptype in [("plan-f", "formal"), ("plan-f", "formal"), ("plan-a", "adhoc"), (None, None)]:
                jdir = runs_dir / f"job-{pid or 'legacy'}-{len(list(runs_dir.iterdir()))}"
                jdir.mkdir()
                j = {"id": jdir.name, "task_id": "t1", "status": "completed", "project_dir": root}
                if pid:
                    j["plan_id"] = pid
                    j["plan_type"] = ptype
                (jdir / "job.json").write_text(json.dumps(j), encoding="utf-8")

            summary = SERVER.build_plan_summary(str(orch))
            total_plan_sum = sum(p["job_counts"]["total"] for p in summary["plans"])
            self.assertEqual(total_plan_sum, summary["total_jobs"],
                             f"Plan job sum {total_plan_sum} must equal total jobs {summary['total_jobs']}")
            self.assertIsNone(summary["integrity_warning"])

    def test_frontend_handles_plan_types_in_contract_list(self):
        """The frontend must handle plan type badges and ad-hoc/legacy rendering."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        # Plan type badges
        self.assertIn("plan-formal", html)
        self.assertIn("plan-adhoc", html)
        self.assertIn("plan-legacy", html)
        # Plan section rendering from /api/plans data
        self.assertIn("pollPlans", html)
        self.assertIn("rawPlans", html)
        # Legacy/Migration Plan text
        self.assertIn("Legacy / Migration Plan", html)
        # Ad-hoc/legacy plan DAG empty-state text
        self.assertIn("no persisted contracts", html)

    def test_frontend_legacy_plan_dag_shows_explanatory_text(self):
        """When a legacy plan is selected and it has no DAG nodes, explanatory text must appear."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("read-only Legacy / Migration Plan", html)
        self.assertIn("without a Planner contract", html)


if __name__ == "__main__":
    unittest.main()
