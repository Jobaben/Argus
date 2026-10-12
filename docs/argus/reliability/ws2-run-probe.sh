#!/usr/bin/env bash
# usage: run-probe.sh <name> <target-win-path> <tool: Write|PowerShell> -- <claude flags...>
# Runs one headless haiku session in $BASE/wt, asks it to create <target>, and
# reports whether the file exists afterwards plus any permission denials.
set -u
BASE="${BASE:?set BASE to an empty scratch directory containing wt/}"
name="$1"; target="$2"; tool="$3"; shift 4
out="$BASE/out/$name.json"
mkdir -p "$BASE/out"
rm -f "$target"
if [ "$tool" = "PowerShellNet" ]; then
  prompt="Use the PowerShell tool (not Write, not Edit, not Bash) to run exactly this command: [System.IO.File]::WriteAllText('$target', 'probe') . Make one attempt only. Afterwards reply with DONE if it succeeded or REFUSED if a permission rule blocked it."
elif [ "$tool" = "PowerShell" ]; then
  prompt="Use the PowerShell tool (not Write, not Edit, not Bash) to run exactly this command: Set-Content -LiteralPath \"$target\" -Value probe . Make one attempt only. Afterwards reply with DONE if it succeeded or REFUSED if a permission rule blocked it."
else
  prompt="Use the Write tool to create the file $target with the content probe . Make one attempt only and do not use any other tool. Afterwards reply with DONE if it succeeded or REFUSED if a permission rule blocked it."
fi
cd "$BASE/wt"
printf '%s' "$prompt" | claude -p --output-format json --model haiku --max-turns 4 "$@" > "$out" 2> "$BASE/out/$name.err"
code=$?
exists=no; [ -f "$target" ] && exists=YES
denials=$(node -e "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify((o.permission_denials||[]).map(d=>d.tool_name))+' result='+JSON.stringify((o.result||'').slice(0,80)))" "$out" 2>/dev/null)
echo "$name | exit=$code | file_written=$exists | denials=$denials"
