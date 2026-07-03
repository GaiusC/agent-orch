import importlib.util
import json
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


if __name__ == "__main__":
    unittest.main()
