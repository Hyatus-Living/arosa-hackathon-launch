"""Supervisor contract tests for architecture_worker.py, using a fake Blender."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / "architecture_worker.py"
FAKE = Path(__file__).resolve().parent / "fake_blender.py"

VERIFICATION_KEYS = {
    "status", "blender", "bonsai", "ifcopenshell", "importer", "elements", "bounds",
    "outputs", "hashes", "timings", "peakMemoryMb",
}


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class JobCase(unittest.TestCase):
    """A job directory, a fake Blender and the supervisor run against them."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="arch-worker-test-")).resolve()
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])
        self.job = self.tmp / "jobs" / "job-1"
        (self.job / "input").mkdir(parents=True)
        (self.job / "input" / "model.ifc").write_text("ISO-10303-21;\nEND-ISO-10303-21;\n")
        self.write_job()
        blender = self.tmp / "fake-blender"
        blender.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
        blender.chmod(0o755)
        self.env = {
            "PATH": os.environ["PATH"],
            "ACRES_BLENDER": str(blender),
            "ACRES_BLENDER_USER_RESOURCES": str(self.tmp / "user-resources"),
            "PRODUCTION_SECRET": "must-not-leak",
        }

    def write_job(self, **overrides):
        job = {
            "jobId": "job-1", "projectId": "project-1", "revision": 3,
            "settings": {"preview": {"width": 320, "height": 240}}, "deadlineSeconds": 60,
        }
        job.update(overrides)
        (self.job / "job.json").write_text(json.dumps(job))

    def mode(self, mode):
        (self.job / "fake-mode").write_text(mode)

    def run_worker(self):
        return subprocess.run(
            [sys.executable, str(WORKER), "--job", str(self.job)],
            env=self.env, capture_output=True, text=True, timeout=60,
        )

    def verification(self):
        return json.loads((self.job / "output" / "verification.json").read_text())

    def assert_failed(self, result, reason_part):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        verification = self.verification()
        self.assertEqual(verification["status"], "failed")
        self.assertIn(reason_part, verification["reason"])
        return verification

    def assert_reaped(self):
        pids = [int(p) for p in (self.job / "pids").read_text().split()]
        deadline = time.monotonic() + 3
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual([pid for pid in pids if alive(pid)], [])


class WorkerTest(JobCase):
    def test_success_writes_verification_contract(self):
        self.mode("ok")
        result = self.run_worker()
        self.assertEqual(result.returncode, 0, result.stderr)
        verification = self.verification()
        self.assertEqual(set(verification), VERIFICATION_KEYS)
        self.assertEqual(verification["status"], "succeeded")
        self.assertEqual(verification["importer"], "bonsai")
        self.assertEqual(verification["outputs"], {
            "blend": "output/model.blend", "preview": "output/preview.png",
            "glb": "output/model.glb", "manifest": "output/manifest.json",
        })
        glb = (self.job / "output" / "model.glb").read_bytes()
        self.assertEqual(verification["hashes"]["glbSha256"], hashlib.sha256(glb).hexdigest())
        self.assertEqual(set(verification["hashes"]), {"glbSha256", "blendSha256", "previewSha256", "manifestSha256"})
        self.assertEqual(set(verification["timings"]), {"importSeconds", "renderSeconds", "exportSeconds", "totalSeconds"})
        self.assertGreater(verification["peakMemoryMb"], 0)
        self.assertFalse((self.job / "output" / "blender-report.json").exists())

    def test_blender_runs_in_background_with_scrubbed_environment(self):
        self.mode("ok")
        self.assertEqual(self.run_worker().returncode, 0)
        for phase in ("import", "publish"):
            ran = json.loads((self.job / f"fake-ran-{phase}").read_text())
            self.assertIn("--background", ran["argv"])
            self.assertIn("--factory-startup", ran["argv"])
            self.assertEqual(ran["argv"][-3:], ["--", str(self.job), phase])
            self.assertNotIn("PRODUCTION_SECRET", ran["env"])
            self.assertEqual(ran["env"]["HOME"], str(self.job / "tmp" / "home"))
            self.assertEqual(ran["env"]["BLENDER_USER_RESOURCES"], self.env["ACRES_BLENDER_USER_RESOURCES"])

    def test_gpu_host_cycles_device_reaches_blender(self):
        self.mode("ok")
        self.env["ACRES_CYCLES_DEVICE"] = "OPTIX"
        self.assertEqual(self.run_worker().returncode, 0)
        for phase in ("import", "publish"):
            ran = json.loads((self.job / f"fake-ran-{phase}").read_text())
            self.assertEqual(ran["env"]["ACRES_CYCLES_DEVICE"], "OPTIX")

    def test_publish_phase_reopens_the_saved_blend_in_a_fresh_blender(self):
        self.mode("ok")
        self.assertEqual(self.run_worker().returncode, 0)
        importing = json.loads((self.job / "fake-ran-import").read_text())["argv"]
        publishing = json.loads((self.job / "fake-ran-publish").read_text())["argv"]
        blend = str(self.job / "output" / "model.blend")
        self.assertNotIn(blend, importing)
        self.assertLess(publishing.index(blend), publishing.index("--python"))

    def test_import_without_blend_fails_before_publish(self):
        self.mode("no-blend")
        self.assert_failed(self.run_worker(), "model.blend")
        self.assertFalse((self.job / "fake-ran-publish").exists())

    def test_manifest_with_duplicate_node_names_fails(self):
        self.mode("duplicate-node")
        self.assert_failed(self.run_worker(), "duplicate glbNodeName")

    def test_manifest_collision_must_reference_objects(self):
        self.mode("dangling-collision")
        self.assert_failed(self.run_worker(), "collision")

    def test_manifest_nodes_must_exist_in_glb(self):
        self.mode("glb-missing-node")
        self.assert_failed(self.run_worker(), "ifc-slab-a")

    def test_missing_output_fails(self):
        self.mode("missing-glb")
        self.assert_failed(self.run_worker(), "model.glb")

    def test_blender_crash_reports_exit_code_and_log_tail(self):
        self.mode("crash")
        verification = self.assert_failed(self.run_worker(), "exit code 3")
        self.assertIn("fake importer exploded", verification["reason"])

    def test_deadline_kills_whole_process_group_before_the_job_deadline(self):
        # Blender gets the deadline minus a margin, so the supervisor finishes before
        # the research service's own SIGKILL at deadlineSeconds.
        self.mode("sleep")
        self.write_job(deadlineSeconds=9)
        started = time.monotonic()
        self.assert_failed(self.run_worker(), "deadline")
        self.assertLess(time.monotonic() - started, 9)
        self.assert_reaped()

    def test_deadline_shorter_than_margin_fails_before_blender(self):
        self.mode("ok")
        self.write_job(deadlineSeconds=5)
        self.assert_failed(self.run_worker(), "deadline")
        self.assertFalse((self.job / "fake-ran-import").exists())

    @unittest.skipUnless(sys.platform == "linux", "PR_SET_PDEATHSIG is Linux-only")
    def test_blender_dies_when_supervisor_is_sigkilled(self):
        self.mode("sleep")
        proc = subprocess.Popen([sys.executable, str(WORKER), "--job", str(self.job)], env=self.env)
        deadline = time.monotonic() + 10
        while not (self.job / "pids").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        blender_pid = int((self.job / "pids").read_text().split()[0])
        proc.kill()
        proc.wait()
        deadline = time.monotonic() + 3
        while alive(blender_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(blender_pid))

    def test_successful_run_leaves_no_descendants(self):
        self.mode("ok-with-straggler")
        self.assertEqual(self.run_worker().returncode, 0)
        self.assert_reaped()

    def test_sigterm_cancels_and_kills_process_group(self):
        self.mode("sleep")
        proc = subprocess.Popen([sys.executable, str(WORKER), "--job", str(self.job)], env=self.env)
        deadline = time.monotonic() + 10
        while not (self.job / "pids").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        proc.send_signal(signal.SIGTERM)
        self.assertNotEqual(proc.wait(timeout=15), 0)
        self.assertIn("cancelled", self.verification()["reason"])
        self.assert_reaped()

    def test_input_symlink_outside_job_dir_is_rejected(self):
        self.mode("ok")
        secret = self.tmp / "secret.ifc"
        secret.write_text("outside")
        (self.job / "input" / "model.ifc").unlink()
        (self.job / "input" / "model.ifc").symlink_to(secret)
        self.assert_failed(self.run_worker(), "outside the job directory")
        self.assertFalse((self.job / "fake-ran-import").exists())

    def test_output_dir_symlink_outside_job_dir_is_rejected(self):
        self.mode("ok")
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (self.job / "output").symlink_to(elsewhere)
        result = self.run_worker()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside the job directory", result.stderr)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertFalse((self.job / "fake-ran-import").exists())

    def test_invalid_job_settings_fail_before_blender(self):
        self.mode("ok")
        self.write_job(settings={"preview": {"width": 0, "height": 240}})
        self.assert_failed(self.run_worker(), "preview")
        self.assertFalse((self.job / "fake-ran-import").exists())


class RenderJobTest(JobCase):
    """A render job: one Blender run of render_job.py on input/scene.json, two PNG stills."""

    def setUp(self):
        super().setUp()
        (self.job / "input" / "model.ifc").unlink()
        (self.job / "input" / "scene.json").write_text(json.dumps({"schema": "acres.render.scene/1"}))
        self.write_job(kind="render", revision=0, settings={"render": {"width": 640, "height": 400, "samples": 8}})

    def test_render_writes_both_stills_with_hashes_keyed_by_artifact_kind(self):
        self.mode("render-ok")
        result = self.run_worker()
        self.assertEqual(result.returncode, 0, result.stderr)
        verification = self.verification()
        self.assertEqual(verification["status"], "succeeded")
        self.assertEqual(verification["kind"], "render")
        self.assertEqual(verification["outputs"], {"render-street": "output/street.png", "render-aerial": "output/aerial.png"})
        street = (self.job / "output" / "street.png").read_bytes()
        self.assertEqual(verification["hashes"]["render-streetSha256"], hashlib.sha256(street).hexdigest())
        self.assertEqual(set(verification["timings"]), {"streetSeconds", "aerialSeconds", "blenderSeconds", "totalSeconds"})
        ran = json.loads((self.job / "fake-ran-render").read_text())
        self.assertTrue(ran["argv"][ran["argv"].index("--python") + 1].endswith("render_job.py"))
        self.assertNotIn("PRODUCTION_SECRET", ran["env"])
        self.assertFalse((self.job / "output" / "blender-report.json").exists())

    def test_render_stills_are_identical_across_runs(self):
        # Cycles stamps its render time into each PNG; the supervisor drops text chunks before hashing.
        self.mode("render-ok")
        hashes = []
        for _ in range(2):
            self.assertEqual(self.run_worker().returncode, 0)
            hashes.append(self.verification()["hashes"])
            self.assertNotIn(b"tEXt", (self.job / "output" / "street.png").read_bytes())
        self.assertEqual(hashes[0], hashes[1])

    def test_render_of_the_wrong_size_fails(self):
        self.mode("render-wrong-size")
        self.assert_failed(self.run_worker(), "is not 640 x 400")

    def test_render_without_a_scene_fails_before_blender(self):
        self.mode("render-ok")
        (self.job / "input" / "scene.json").unlink()
        self.assert_failed(self.run_worker(), "scene.json is missing")
        self.assertFalse((self.job / "fake-ran-render").exists())

    def test_render_settings_are_bounded(self):
        self.mode("render-ok")
        for render in ({"width": 4096, "height": 400, "samples": 8}, {"width": 640, "height": 400, "samples": 500}, {"width": 640, "height": 400}):
            self.write_job(kind="render", revision=0, settings={"render": render})
            self.assert_failed(self.run_worker(), "settings.render")
        self.assertFalse((self.job / "fake-ran-render").exists())

    def test_render_deadline_kills_blender(self):
        self.mode("sleep")
        self.write_job(kind="render", revision=0, deadlineSeconds=9, settings={"render": {"width": 640, "height": 400, "samples": 8}})
        self.assert_failed(self.run_worker(), "deadline exceeded during the render phase")
        self.assert_reaped()


if __name__ == "__main__":
    unittest.main()
