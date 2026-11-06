"""Offline regression tests: no Modal app, container, or credentials needed."""

import ast
from pathlib import Path
import subprocess
from threading import Barrier
import unittest
from unittest.mock import MagicMock, patch

import modal_ci as ci


class ModalCITests(unittest.TestCase):
    def setUp(self):
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)

    def test_dispatches_both_tasks_in_parallel(self):
        ready = Barrier(2, timeout=5)
        with patch.object(ci, "run_checks") as checks, patch.object(ci, "run_suite") as suite:
            checks.remote.side_effect = lambda: ready.wait()
            suite.remote.side_effect = lambda: ready.wait()
            ci.run_tests()
            checks.remote.assert_called_once_with()
            suite.remote.assert_called_once_with()

    def test_failure_does_not_skip_other_task(self):
        for failed in ("check", "test", "both"):
            with self.subTest(failed=failed), patch.object(ci, "run_checks") as checks:
                with patch.object(ci, "run_suite") as suite:
                    if failed in ("check", "both"):
                        checks.remote.side_effect = RuntimeError("checks failed")
                    if failed in ("test", "both"):
                        suite.remote.side_effect = RuntimeError("suite failed")
                    with self.assertRaisesRegex(RuntimeError, "Modal CI failures") as error:
                        ci.run_tests()
                    checks.remote.assert_called_once_with()
                    suite.remote.assert_called_once_with()
                    for name in ("check", "test") if failed == "both" else (failed,):
                        self.assertIn(name, str(error.exception))

    def test_task_commands_and_failure_propagation(self):
        for function, commands in (
            (ci.run_checks, [
                ["node", "--version"],
                ["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"],
                ["npm", "run", "check"],
            ]),
            (ci.run_suite, [["node", "--version"], ["npm", "test"]]),
        ):
            with self.subTest(commands=commands), patch.object(ci.subprocess, "run") as run:
                function.local()
                self.assertEqual([call.args[0] for call in run.call_args_list], commands)
                for call in run.call_args_list:
                    self.assertEqual(call.kwargs, {"cwd": "/workspace", "check": True})
            for index in range(len(commands)):
                with self.subTest(commands=commands, index=index), patch.object(
                    ci.subprocess, "run",
                    side_effect=[None] * index + [subprocess.CalledProcessError(1, commands[index])],
                ) as run:
                    with self.assertRaises(subprocess.CalledProcessError):
                        function.local()
                    self.assertEqual(run.call_count, index + 1)

    def mock_image(self):
        image = MagicMock()
        for method in ("apt_install", "env", "workdir", "add_local_file", "add_local_dir", "run_commands"):
            getattr(image, method).return_value = image
        return image

    def test_source_upload_allowlist_and_cached_install(self):
        image = self.mock_image()
        with patch.object(ci.modal, "is_local", return_value=True):
            with patch.object(ci.modal.Image, "from_registry", return_value=image) as registry:
                self.assertIs(ci.make_image(), image)
        registry.assert_called_once_with("node:22-bookworm-slim", add_python="3.11")
        image.apt_install.assert_called_once_with("git")
        image.env.assert_called_once_with({"CI": "true"})
        image.workdir.assert_called_once_with("/workspace")
        files = {
            str(call.args[0].relative_to(ci.ROOT)): call
            for call in image.add_local_file.call_args_list
        }
        self.assertEqual(set(files), {
            "package.json", "package-lock.json", "server.mjs",
            "README.md", "README.ko.md", "LICENSE", "CHANGELOG.md",
            ".env.example", "mcp.example.json",
            "ci/npm_release_helpers.mjs", "ci/modal_ci.py", "ci/test_modal_ci.py",
        })
        for path, call in files.items():
            self.assertEqual(call.args[1], f"/workspace/{path}")
            self.assertEqual(call.kwargs, {"copy": True} if path.startswith("package") else {})
        self.assertEqual([call.args for call in image.add_local_dir.call_args_list], [
            (ci.ROOT / "src", "/workspace/src"),
            (ci.ROOT / "test", "/workspace/test"),
        ])
        image.run_commands.assert_called_once_with("npm ci --include=dev")

    def test_remote_import_does_not_inspect_local_upload_inputs(self):
        image = self.mock_image()
        with patch.object(ci.modal, "is_local", return_value=False):
            with patch.object(ci.modal.Image, "from_registry", return_value=image):
                with patch.object(Path, "read_text", side_effect=AssertionError("local read")):
                    self.assertIs(ci.make_image(), image)
        image.add_local_file.assert_not_called()
        image.add_local_dir.assert_not_called()
        image.run_commands.assert_not_called()

    def test_one_app_definition_and_two_remote_functions(self):
        tree = ast.parse(Path(ci.__file__).read_text())
        app_calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Attribute)
                     and isinstance(node.func.value, ast.Name)
                     and node.func.value.id == "modal" and node.func.attr == "App"]
        self.assertEqual(len(app_calls), 1)
        remote_functions = {
            node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
            and any(isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and isinstance(decorator.func.value, ast.Name)
                    and decorator.func.value.id == "app" and decorator.func.attr == "function"
                    for decorator in node.decorator_list)
        }
        self.assertEqual(remote_functions, {"run_checks", "run_suite"})


if __name__ == "__main__":
    unittest.main()
