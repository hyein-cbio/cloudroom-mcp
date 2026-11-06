"""Run isolated Node.js checks and tests in one shared Modal app."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import subprocess

import modal


ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = "/workspace"
app = modal.App("cloudroom-mcp-ci")


def make_image():
    image = (
        modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
        .env({"CI": "true"})
        .workdir(WORKSPACE)
    )
    # Modal re-imports this module remotely; upload paths only exist locally.
    if not modal.is_local():
        return image
    # Cache dependencies separately from source. Never upload .env, .git,
    # local node_modules, or credentials; both tasks share this image definition.
    image = (
        image
        .add_local_file(ROOT / "package.json", f"{WORKSPACE}/package.json", copy=True)
        .add_local_file(ROOT / "package-lock.json", f"{WORKSPACE}/package-lock.json", copy=True)
        .run_commands("npm ci --include=dev")
    )
    for name in (
        "README.md", "README.ko.md", "LICENSE", "CHANGELOG.md",
        ".env.example", "mcp.example.json",
    ):
        image = image.add_local_file(ROOT / name, f"{WORKSPACE}/{name}")
    return (
        image
        .add_local_file(ROOT / "server.mjs", f"{WORKSPACE}/server.mjs")
        .add_local_dir(ROOT / "src", f"{WORKSPACE}/src")
        .add_local_dir(ROOT / "test", f"{WORKSPACE}/test")
        .add_local_file(ROOT / "ci/modal_ci.py", f"{WORKSPACE}/ci/modal_ci.py")
        .add_local_file(ROOT / "ci/test_modal_ci.py", f"{WORKSPACE}/ci/test_modal_ci.py")
    )


image = make_image()


def run_commands(commands):
    for command in (["node", "--version"], *commands):
        print(f"+ {' '.join(command)}", flush=True)
        # Propagate failures to the dispatcher and therefore to GitHub Actions.
        subprocess.run(command, cwd=WORKSPACE, check=True)


@app.function(image=image, cpu=1, memory=1024, timeout=300, retries=0)
def run_checks():
    run_commands((
        ["python", "-m", "unittest", "discover", "-s", "ci", "-p", "test_*.py"],
        ["npm", "run", "check"],
    ))


@app.function(image=image, cpu=1, memory=1024, timeout=300, retries=0)
def run_suite():
    run_commands((["npm", "test"],))


@app.local_entrypoint()
def run_tests():
    """One ephemeral app per run; checks and tests use separate containers."""
    failures = []
    # Never launch modal run once per task: remote calls share this app instead.
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {
            pool.submit(function.remote): name
            for name, function in (("check", run_checks), ("test", run_suite))
        }
        for future in as_completed(pending):
            name = pending[future]
            try:
                future.result()
            except Exception as error:
                # Let the other task finish even if one fails.
                failures.append(name)
                print(f"FAIL {name}: {error}", flush=True)
            else:
                print(f"PASS {name}", flush=True)
    if failures:
        raise RuntimeError(f"Modal CI failures: {sorted(failures)}")
