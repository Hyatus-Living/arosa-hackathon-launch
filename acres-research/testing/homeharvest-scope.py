"""Exercise the actual bridge main with an empty deterministic provider, without network access."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import types

payload = json.loads(sys.stdin.read())
calls = []
provider = types.ModuleType('homeharvest')
def scrape_property(**kwargs):
    calls.append(kwargs)
    return []
provider.scrape_property = scrape_property
sys.modules['homeharvest'] = provider
bridge = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'homeharvest-bridge.py'))
output = io.StringIO()
sys.stdin = io.StringIO(json.dumps(payload))
with contextlib.redirect_stdout(output):
    bridge['main']()
json.dump({'calls': calls, 'result': json.loads(output.getvalue())}, sys.stdout)
