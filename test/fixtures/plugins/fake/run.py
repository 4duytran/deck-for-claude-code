#!/usr/bin/env python3
"""Fixture plugin of plugin-runner-probe.

Records what the runner handed it: the env NAMES, a sha256 per value (never a value), argv, cwd and
whether fd 3 leaked. Writes the report, prints one marker line on stdout and one on stderr, then
sleeps argv[2] seconds and exits with the code argv[1] (the probe's knobs).
"""
import hashlib
import json
import os
import sys
import time

fd3_open = os.path.exists('/proc/self/fd/3')
# /proc/self/environ is the block the process was exec'd with: python never adds a name to it.
raw = open('/proc/self/environ', 'rb').read().split(b'\0')
env = dict(p.split(b'=', 1) for p in raw if b'=' in p)
rec = {
    'names': sorted(k.decode() for k in env),
    'sha256': {k.decode(): hashlib.sha256(v).hexdigest() for k, v in env.items()},
    'argv': sys.argv,
    'cwd': os.getcwd(),
    'fd3_open': fd3_open,
}
with open(os.path.join(os.environ['DECK_PLUGIN_DATA_DIR'], 'record.json'), 'w') as f:
    json.dump(rec, f)
with open(os.environ['DECK_PLUGIN_REPORT'], 'w') as f:
    f.write('<!doctype html><title>fake</title><p>fake report</p>')
print('fake-plugin-stdout', flush=True)
print('fake-plugin-stderr', file=sys.stderr, flush=True)
code = int(sys.argv[1]) if len(sys.argv) > 1 else 0
if len(sys.argv) > 2:
    time.sleep(float(sys.argv[2]))
sys.exit(code)
