#!/usr/bin/env python3
"""Package installed pinned application dependencies; no credentials or network downloads."""
import sys,json,tarfile,io,pathlib
manifest=json.loads(sys.stdin.buffer.read(100000));out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:gz') as archive:
 for item in manifest['packages']:
  archive.add(item['path'],arcname='node_modules/'+item['name'])
 archive.add(manifest['worker'],arcname='worker.cjs')
sys.stdout.buffer.write(out.getvalue())
