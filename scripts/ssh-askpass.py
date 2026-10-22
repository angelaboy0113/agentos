#!/usr/bin/env python3
"""SSH captures the password through askpass; never print to an interactive terminal."""
import os,sys,subprocess,json,pathlib
if os.isatty(sys.stdout.fileno()):sys.exit(1)
ref=os.environ.get('AGENTOS_SSH_CREDENTIAL_REF','')
if not ref:sys.exit(1)
p=subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('keychain-credential.py')),'get',ref],capture_output=True)
if p.returncode:sys.exit(1)
sys.stdout.write(json.loads(p.stdout)['password'])
