#!/usr/bin/env bash
# Extract the JSON body of the last <output>...</output> block from a Pi
# transcript file. Prompts that need structured output (write-pr, review,
# update-branch) instruct the model to emit exactly one such block as the
# last thing in its response; this has no schema validation or retry the
# way sandcastle's Output.object() did, so a malformed block just fails the
# `jq` parse downstream and the workflow falls through to its blocked-label
# failure path.
set -euo pipefail

file="$1"

awk '
  {
    rest = $0
    while (length(rest) > 0) {
      if (!capturing) {
        start = index(rest, "<output>")
        if (!start) {
          break
        }
        capturing = 1
        buf = ""
        rest = substr(rest, start + length("<output>"))
      } else {
        finish = index(rest, "</output>")
        if (finish) {
          buf = buf substr(rest, 1, finish - 1)
          sub(/\n$/, "", buf)
          last = buf
          found = 1
          capturing = 0
          rest = substr(rest, finish + length("</output>"))
        } else {
          buf = buf rest "\n"
          break
        }
      }
    }
  }
  END {
    if (!found) {
      print "No complete <output>...</output> block found." > "/dev/stderr"
      exit 1
    }
    printf "%s", last
  }
' "$file"
