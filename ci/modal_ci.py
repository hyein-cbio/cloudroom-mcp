"""Run the checked-out Node.js test suite on Modal, without Cloudroom access."""

from pathlib import Path
import subprocess

import modal


ROOT = Path(__file__).resolve().parent.parent
app = modal.App("cloudroom-mcp-ci")

# Cache dependency installation separately from frequently changing source files.
# Upload only test inputs, never .env, .git, or the local node_modules directory.
image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
    .env({"CI": "true"})
    .workdir("/workspace")
    .add_local_file(ROOT / "package.json", "/workspace/package.json", copy=True)
    .add_local_file(ROOT / "package-lock.json", "/workspace/package-lock.json", copy=True)
    .run_commands("npm ci --include=dev")
    .add_local_file(ROOT / "server.mjs", "/workspace/server.mjs")
    .add_local_dir(ROOT / "src", "/workspace/src")
    .add_local_dir(ROOT / "test", "/workspace/test")
)


@app.function(image=image, cpu=1, memory=1024, timeout=300, retries=0)
def run_tests():
    for command in (
        ["node", "--version"],
        ["npm", "run", "check"],
        ["npm", "test"],
    ):
        print(f"+ {' '.join(command)}", flush=True)
        # Propagate failures to modal run and therefore to GitHub Actions.
        subprocess.run(command, cwd="/workspace", check=True)
