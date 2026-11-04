"""The GPU dispatcher's job transfer: what leaves for the GPU host and what comes back."""

import io
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import remote_worker  # noqa: E402


class TransferTest(unittest.TestCase):
    def setUp(self):
        self.job = Path(tempfile.mkdtemp(prefix="gpu-transfer-")) / "job-1"
        (self.job / "input").mkdir(parents=True)
        (self.job / "output").mkdir()
        (self.job / "job.json").write_text('{"jobId": "job-1"}')
        (self.job / "input" / "model.ifc").write_text("ISO-10303-21;")
        (self.job / "worker.log").write_text("research's own log")

    def test_only_the_job_and_its_input_are_sent(self):
        with tarfile.open(fileobj=io.BytesIO(remote_worker.bundle(self.job))) as tar:
            self.assertEqual(sorted(tar.getnames()), ["input", "input/model.ifc", "job.json"])

    def test_only_output_is_unpacked_and_never_outside_the_job(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as tar:
            for name, body in (("output/verification.json", b"{}"), ("job.json", b"replaced"), ("../escape.txt", b"x")):
                info = tarfile.TarInfo(name)
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
        remote_worker.unpack(data.getvalue(), self.job)
        self.assertEqual((self.job / "output" / "verification.json").read_text(), "{}")
        self.assertEqual((self.job / "job.json").read_text(), '{"jobId": "job-1"}')
        self.assertFalse((self.job.parent / "escape.txt").exists())


if __name__ == "__main__":
    unittest.main()
