# 90-second demo script

> Goal: install → agent appears live → schedule fires → budget stop →
> failure grouped into an issue. Ready to record as-is; every step names
> what to type, what to click, and what the camera should see.

## Prep (off-camera, before recording)

- A machine with Node ≥ 22, `claude` CLI authenticated, and a real (or
  seeded) `~/.claude` so tabs aren't empty.
- Terminal at a large font on the left half; browser on the right half.
- Pre-create **one failing schedule** ~10 minutes before recording: a
  schedule named `nightly-triage` whose prompt targets a directory that
  doesn't exist (guaranteed spawn failure), interval **every 2 minutes** —
  by recording time it has failed 3–5 times, so Issues has an ×N card.
- Set the Budget **daily limit low enough to already be exceeded** by
  today's test spend (e.g. $0.10 if today's runs cost more), but **leave the
  hard-stop checkbox OFF** — you'll switch it on on camera.
- Pre-write a one-off prompt in a note to paste, e.g.
  `Summarize the three most recent commits in ~/GIT/demo-repo.`

## Timeline

**[0:00–0:12] Install — one command.**
Terminal:

```bash
git clone https://github.com/Jobaben/Argus.git && cd Argus
node bin/argus.mjs --open
```

_(Cut the build wait in editing; keep the log lines `installing
dependencies…` → `building UI and server…` → `argus listening` visible as a
2-second montage.)_ Browser opens on the Command Center.

Voiceover: "One clone, one command. Argus builds itself and opens the
dashboard."

**[0:12–0:30] An agent appears live.**
Click **Launch**. Paste the prepared prompt, click **Run**. Split-screen
moment: the run card appears immediately, status pill flips to _running_,
and the live log starts streaming text as the agent works.

Voiceover: "This is a real headless Claude Code run, streaming live —
tokens, cost, and output as they happen."

**[0:30–0:48] A schedule fires on its own.**
Click **Scheduler**. The `nightly-triage` schedule shows its next-fire
countdown at under a minute (time the recording so it fires on camera —
that's why the interval is 2 minutes). When it fires, the run row appears
without you touching anything.

Voiceover: "Schedules fire while you're not looking — interval, daily,
weekly — and if the machine was asleep, catch-up can cover the missed slot."

**[0:48–1:06] The budget stop.**
Click **Budget**. Today's bar is already red — over the daily limit. Tick
**"Pause scheduled runs while over budget"**, save. Back to **Scheduler**:
the next `nightly-triage` slot fires as **skipped — "spend budget
exceeded"**, recorded in the history instead of silently missing.

Voiceover: "Limits are enforced, not advisory. Over budget, scheduled runs
are skipped and _say so_. Manual runs still work — a human clicking a button
is its own authorization."

**[1:06–1:24] Failures become one issue, not twenty rows.**
Click **Issues**. One card: the `nightly-triage` spawn error with an **×4**
badge, first/last seen, affected schedule. Expand it → the individual
occurrences. Click **Resolve**.

Voiceover: "Every failure is fingerprinted. Twenty identical timeouts are
one issue with a count — resolve it, and it auto-reopens only if it comes
back."

**[1:24–1:30] Close.**
`⌘K`, type `bud`, Enter — palette jumps to Budget. Cut to the README's
one-line pitch.

Voiceover: "Schedule it, cap it, gate it, and know when it breaks. Argus —
the control plane for Claude Code agents. Link below."

## Recording notes

- 1440×900 browser viewport (matches the doc screenshot convention).
- Total speaking time ≈ 75s at a calm pace; the budget section is the most
  cuttable if it runs long.
- If the live schedule refuses to cooperate on camera, the Scheduler tab's
  **Run now** on `nightly-triage` is an honest fallback — it exercises the
  same path.
