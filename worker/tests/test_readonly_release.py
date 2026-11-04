"""Real Blender + Bonsai job against a genuinely read-only release (as under the systemd unit).

Needs an installed release and a private mount namespace (Linux user namespaces, or root);
skipped otherwise:
  ACRES_WORKER_RELEASE=/opt/acres-architecture-worker/current python3 -m unittest worker/tests/test_readonly_release.py

The release is bind-mounted read-only over itself inside a private mount namespace, so writes
and chmod fail with EROFS exactly as with ProtectSystem=strict. `chmod -R a-w` is not
equivalent: the owner may still chmod a file without write bits.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

RELEASE = os.environ.get("ACRES_WORKER_RELEASE")


UNSHARE = ["unshare", "--mount"] if os.geteuid() == 0 else ["unshare", "--user", "--map-root-user", "--mount"]


def can_unshare():
    return shutil.which("unshare") and subprocess.run([*UNSHARE, "true"], capture_output=True).returncode == 0


@unittest.skipUnless(RELEASE and can_unshare(), "needs ACRES_WORKER_RELEASE and a private mount namespace")
class ReadOnlyReleaseTest(unittest.TestCase):
    def test_fixture_job_succeeds_with_read_only_release_and_empty_home(self):
        release = Path(RELEASE).resolve()
        job = Path(tempfile.mkdtemp(prefix="arch-readonly-")).resolve()
        self.addCleanup(shutil.rmtree, job)
        (job / "input").mkdir()
        subprocess.run([release / "bin" / "make-fixture", job / "input" / "model.ifc"], check=True)
        (job / "job.json").write_text(json.dumps({
            "jobId": "readonly", "projectId": "readonly", "revision": 1,
            "settings": {"preview": {"width": 64, "height": 48}}, "deadlineSeconds": 300,
        }))
        script = (f'mount --bind "{release}" "{release}" && mount -o remount,bind,ro "{release}" || exit 98; '
                  f'touch "{release}/.write-probe" 2>/dev/null && exit 99; '
                  f'exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "{release}/bin/architecture-worker" --job "{job}"')
        result = subprocess.run([*UNSHARE, "sh", "-c", script],
                                capture_output=True, text=True, timeout=400)
        self.assertNotIn(result.returncode, (98, 99), f"could not make the release read-only: {result.stderr}")
        verification = json.loads((job / "output" / "verification.json").read_text())
        self.assertEqual(verification["status"], "succeeded", verification.get("reason", "")[:2000])
        self.assertEqual(verification["elements"], {"walls": 4, "slabs": 1, "spaces": 1, "doors": 1, "windows": 0, "other": 0})
        log = (job / "output" / "blender.log").read_text(errors="replace")
        self.assertNotIn("Read-only file system", log)


if __name__ == "__main__":
    unittest.main()
