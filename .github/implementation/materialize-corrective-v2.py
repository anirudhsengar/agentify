#!/usr/bin/env python3
from pathlib import Path
import subprocess

script_path = Path(".github/implementation/materialize-corrective.py")
text = script_path.read_text()
start = text.index('replace_once(\n    "tests/audit/tracked-specialist-closure.test.ts",')
end = text.index('subprocess.run(["python", ".github/implementation/apply-locality-aware-closure.py"], check=True)', start)
correct = 'replace_once(\n    "tests/audit/tracked-specialist-closure.test.ts",\n    \'fs.writeFileSync(destination, `${JSON.stringify(aqaShapedMap(), null, 2)}\\\\n`);\',\n    \'fs.writeFileSync(destination, `${JSON.stringify(aqaShapedMap(), null, 2)}\\n`);\',\n    "normalize progressive-repair fixture",\n)\n'
script_path.write_text(text[:start] + correct + text[end:])
subprocess.run(["python", str(script_path)], check=True)
