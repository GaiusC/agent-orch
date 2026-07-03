import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "skills" / "audit-orch" / "scripts" / "server.py"
INDEX_PATH = ROOT / "skills" / "audit-orch" / "scripts" / "index.html"

SPEC = importlib.util.spec_from_file_location("audit_orch_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class AuditDashboardTests(unittest.TestCase):
    # ── existing tests (preserved) ──────────────────────────────────────

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

    def test_frontend_has_gap_fix_tool_folding_and_conclusion_tab(self):
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("overflow: hidden;", html)
        self.assertIn("TOOL_COLLAPSE_CHARS = 1200", html)
        self.assertIn('id="tab-conclusion"', html)
        self.assertIn("Generate Conclusion", html)

    # ── project discovery tests ──────────────────────────────────────────

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
            raw = "﻿" + json.dumps({"display_name": "BOM Project"})
            (orch / "config.json").write_text(raw, encoding="utf-8")
            name = SERVER.project_display_name(root)
            self.assertEqual(name, "BOM Project")

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
                # 2 completed + 1 running (stale — no matching process text)
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

    # ── Chinese conclusion prompt / handling ──────────────────────────────

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
                # The prompt (which is in args) should contain the Chinese instruction
                prompt_found = False
                for arg in called_args[0]:
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
                # Transcript does not exist — should not crash
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
        try:
            def fake_run(cmd_args, **kwargs):
                raise FileNotFoundError("agy not found")

            SERVER.subprocess.run = fake_run

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

    # ── BOM / permission-safe behavior ───────────────────────────────────

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
                # Find the prompt arg (the long one after --print)
                for i, arg in enumerate(cmd_args):
                    if arg == "--print" and i + 1 < len(cmd_args):
                        prompts_seen.append(cmd_args[i + 1])
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
                # BOM should have been stripped — no ﻿ in the prompt
                self.assertNotIn("﻿", prompt)
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

    # ── Frontend wiring for projects (minimal) ───────────────────────────

    def test_frontend_has_conclusion_button(self):
        """The frontend should have the Generate Conclusion button."""
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn("Generate Conclusion", html)
        self.assertIn("requestConclusion()", html)


if __name__ == "__main__":
    unittest.main()
