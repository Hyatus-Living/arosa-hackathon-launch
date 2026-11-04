#!/usr/bin/env python3
"""Run one Acres architecture job on the GPU render host: architecture-worker-gpu --job <jobDir>.

The host is a Compute Engine VM with one NVIDIA T4 (infra/acres-render-gpu). This supervisor starts it
when it is stopped, sends job.json and input/ over OS Login SSH, runs the job there through the same
sandboxed worker unit as on this host (with Cycles on the GPU), and copies output/ back into the job
directory. The host powers itself off after 15 idle minutes, so it is paid for only while it renders.
Where the host does not answer within READY_SECONDS (a zone out of T4s, say) the job runs here on the
CPU worker unit instead. SIGTERM or SIGINT cancels the remote job. Exit status is the job's.

Runs as the research service user. Its service account holds compute.instanceAdmin.v1 and
compute.osAdminLogin on the host only, and the SSH key HOME/.ssh/acres-render-gpu is on that account's
OS Login profile (docs/architecture-worker.md), so plain ssh needs no project-wide permission.
"""

import argparse
import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path

PROJECT = "hyatus-openclaw"
ZONE = "us-central1-a"
HOST = "acres-render-gpu"
HOME = "/var/lib/acres-runtime"
READY_SECONDS = 150
USER = None
LOCAL_WORKER = Path(__file__).resolve().parents[1] / "bin" / "architecture-worker-unit"
ADDRESS = f"{HOST}.{ZONE}.c.{PROJECT}.internal"
GCLOUD = ["gcloud", f"--project={PROJECT}", "--quiet"]
SSH_OPTIONS = [
    "-i", f"{HOME}/.ssh/acres-render-gpu", "-o", f"UserKnownHostsFile={HOME}/.ssh/known_hosts",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
]


class Cancelled(Exception):
    pass


def on_signal(signum, _frame):
    raise Cancelled(signal.Signals(signum).name)


def log(message):
    print(f"[gpu] {message}", flush=True)


def gcloud(*args, timeout=120):
    return subprocess.run([*GCLOUD, *args], capture_output=True, text=True, timeout=timeout)


def login():
    """The OS Login user of this host's service account, which is the SSH user on the GPU host; None when unknown."""
    result = gcloud("compute", "os-login", "describe-profile", "--format=value(posixAccounts[0].username)")
    if result.returncode != 0 or not result.stdout.strip():
        log(f"no OS Login profile: {result.stderr.strip()[-200:]}")
        return None
    return result.stdout.strip()


def ssh(command, *, stdin=None, timeout=None, capture=True):
    """One command on the host as the OS Login user (passwordless sudo there)."""
    return subprocess.run(["ssh", *SSH_OPTIONS, f"{USER}@{ADDRESS}", command], input=stdin, capture_output=capture, timeout=timeout)


def status():
    result = gcloud("compute", "instances", "describe", HOST, f"--zone={ZONE}", "--format=value(status)")
    return result.stdout.strip() if result.returncode == 0 else f"unknown ({result.stderr.strip()[-200:]})"


def ready():
    """Start the host if it is stopped and wait until SSH answers; False when it does not in time."""
    until = time.monotonic() + READY_SECONDS
    while time.monotonic() < until:
        state = status()
        if state in ("TERMINATED", "STOPPED"):
            log(f"starting {HOST}")
            started = gcloud("compute", "instances", "start", HOST, f"--zone={ZONE}", timeout=READY_SECONDS)
            if started.returncode != 0:
                log(f"start failed: {started.stderr.strip()[-300:]}")
                return False
        elif state == "RUNNING":
            try:
                answer = ssh("true", timeout=30)
                if answer.returncode == 0:
                    return True
                log(f"ssh not ready: {answer.stderr.decode().strip()[-200:]}")
            except subprocess.TimeoutExpired:
                log("ssh not ready: timed out")
        time.sleep(5)
    log(f"{HOST} not ready after {READY_SECONDS} s (last status {status()})")
    return False


def bundle(job_dir):
    """job.json and input/ as a tar stream; the job's own log and output stay here."""
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as tar:
        tar.add(job_dir / "job.json", arcname="job.json")
        tar.add(job_dir / "input", arcname="input")
    return data.getvalue()


def unpack(data, job_dir):
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(job_dir, members=[m for m in tar.getmembers() if m.name == "output" or m.name.startswith("output/")], filter="data")


def run_remote(job_dir):
    job_id = job_dir.name
    sent = ssh(f"sudo /usr/local/sbin/acres-gpu-job receive {job_id}", stdin=bundle(job_dir), timeout=120)
    if sent.returncode != 0:
        raise RuntimeError(f"sending the job failed: {sent.stderr.decode()[-300:]}")
    log(f"running {job_id} on {HOST}")
    try:
        code = ssh(f"sudo /usr/local/sbin/acres-gpu-job run {job_id}", capture=False).returncode
        back = ssh(f"sudo /usr/local/sbin/acres-gpu-job send {job_id}", timeout=120)
        if back.returncode != 0:
            raise RuntimeError(f"fetching the output failed: {back.stderr.decode()[-300:]}")
        unpack(back.stdout, job_dir)
    except Cancelled:
        ssh(f"sudo /usr/local/sbin/acres-gpu-job cancel {job_id}", timeout=30)
        raise
    log(f"{job_id} finished on {HOST} with status {code}")
    return code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    job_dir = Path(parser.parse_args().job).resolve()
    json.loads((job_dir / "job.json").read_text())
    os.environ.update(HOME=HOME, CLOUDSDK_CORE_DISABLE_PROMPTS="1")
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    global USER
    try:
        USER = login()
        if not USER or not ready():
            log("running on this host's CPU worker instead")
            os.execv(LOCAL_WORKER, [str(LOCAL_WORKER), "--job", str(job_dir)])
        return run_remote(job_dir)
    except Cancelled as cancelled:
        log(f"cancelled by {cancelled}")
        return 143


if __name__ == "__main__":
    sys.exit(main())
