#!/usr/bin/env python3
"""SSH captures the password from AgentOS' encrypted vault, never a GUI keychain prompt."""
import os,sys,subprocess,pathlib,shutil
if os.isatty(sys.stdout.fileno()):sys.exit(1)
ref=os.environ.get('AGENTOS_SSH_CREDENTIAL_REF','')
if not ref:sys.exit(1)
p=subprocess.run([shutil.which('node') or 'node',str(pathlib.Path(__file__).with_name('credential-read.mjs')),ref,'password'],capture_output=True)
if p.returncode:sys.exit(1)
sys.stdout.buffer.write(p.stdout)
