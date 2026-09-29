# pi-input-history

**Cross-session prompt history and fuzzy reverse search for pi.**

[![npm version](https://img.shields.io/npm/v/pi-input-history?style=for-the-badge)](https://www.npmjs.com/package/pi-input-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

## Why

Pi's built-in ↑/↓ history only covers the current session and is lost on reload. This extension persists your last 100 prompts across sessions and adds fuzzy reverse search (default **Ctrl+R**) to find any past prompt instantly.

![Ctrl+R reverse search](assets/screenshot.png)

## Install

```bash
pi install npm:pi-input-history
```

Or from git:

```bash
pi install git:github.com/ouzhenkun/pi-input-history
```

## Usage

### Persistent History

On session start, your last 100 prompts across all sessions are loaded into the editor. Use **↑/↓** arrows to browse them as usual.

### Reverse Search

1. Press the search shortcut (default **Ctrl+R**) to open the search overlay.
2. Type to fuzzy-filter history (subsequence matching, space-separated multi-token).
3. Matched characters are highlighted with your theme's accent color, using **minimal-span** matching so the highlight stays on the closest contiguous group (e.g. `in` highlights `in` in `input`, not `pi`'s `i` + `input`'s `n`).
4. The preview viewport shows the matched record; long lines are **soft-wrapped** (never truncated) and the viewport grows with content up to your terminal's height, then scrolls.
5. The first matched line is marked with `▸`; the viewport is separated from the input line by a dim divider.
6. Navigate and accept:

| Key | Action |
| --- | --- |
| search shortcut / `↑` | Cycle to older match |
| newer shortcut / `↓` | Cycle to newer match |
| `ctrl+k` / `ctrl+j` | Scroll the preview viewport (when it exceeds the terminal height) |
| `Enter` | Accept match into editor |
| `Esc` / `Ctrl+G` | Cancel |

Defaults: search = `ctrl+r`, newer = `ctrl+s`, scroll up = `ctrl+k`, scroll down = `ctrl+j`.

### Skill invocations

Pi stores an explicitly invoked skill (`/skill:code-review review changes since main`) as the skill's expanded instructions followed by your arguments. Recall shows a compact command, reconstructed from that stored invocation, instead of the expanded body:

```text
/skill:code-review review changes since main
Keep the review focused on authentication.
```

This applies to reverse search (filtering, preview, and the accepted text) and to ↑/↓ history navigation. Recall only fills the editor; it never submits.

- **Stored arguments are kept**, including line breaks, spacing, quotes, and Unicode; only the whole entry's outer whitespace is trimmed, as for every history entry. Tabs and carriage returns are shown the way Pi's editor holds any text it is given: a tab becomes four spaces, and CRLF or CR becomes a line break. An invocation without arguments recalls as `/skill:name`.
- **Reconstructed, not your keystrokes.** The command is rebuilt from what Pi stored, which is not always exactly what you typed: Pi trims the arguments when it expands a skill, and other extensions may have changed the message.
- **Resubmitting runs the current skill.** Pi reads the skill's file again when you submit, so the instructions may differ from the ones originally used.
- **Conservative fallback.** A record is shown as-is (expanded) unless its envelope is unambiguous and the skill with that name is currently loaded from exactly the recorded file. This excludes, for example, unknown or renamed skills, a skill now loaded from a different path, or an extension command that intercepts `/skill:name`. Names outside `A-Z a-z 0-9 . _ : -` (starting with a letter or digit) also stay raw.
- **Text only.** Recognition cannot tell a generated envelope from identical text you pasted yourself, so such a paste is recalled as a command too.
- **History itself is unchanged.** Session files, the 100-prompt cross-session cache, and the editor's stored history keep the expanded text; only what recall shows changes. In reverse search, different expanded versions of the same command appear once, and a converted record is no longer found by words that only occur in the skill body.

### Editor replacement and supported Pi versions

↑/↓ recall is tested against Pi **0.87.1** and its stock editor, including other extensions' editor factories that return it or a subclass. It relies on Pi editor internals that have no public hook, so it adapts an editor only when that editor's history methods are Pi's own, unmodified. Any other editor is left unchanged: ↑/↓ shows skill invocations expanded, while reverse search still shows the command.

When Pi replaces the editor for `/new`, `/resume`, `/fork`, or `/reload`, the extension loads the cross-session history and then the current session's prompts into the new editor, so ↑/↓ keeps the current session's history.

## Configuration

Optional config at `~/.pi/agent/pi-input-history.json`:

```json
{
  "searchShortcut": "ctrl+r",
  "newerShortcut": "ctrl+s",
  "scrollUpShortcut": "ctrl+k",
  "scrollDownShortcut": "ctrl+j"
}
```

| Field | Default | Description |
| --- | --- | --- |
| `searchShortcut` | `ctrl+r` | Open reverse search; press again in the overlay to cycle older |
| `newerShortcut` | `ctrl+s` | In the overlay, cycle to a newer match |
| `scrollUpShortcut` | `ctrl+k` | In the overlay, scroll the preview viewport up |
| `scrollDownShortcut` | `ctrl+j` | In the overlay, scroll the preview viewport down |

Omit the file or any field to keep the default. After editing, run `/reload` in pi.

### Shortcut conflict with `app.session.rename`

Pi binds `app.session.rename` to `ctrl+r` by default (session picker). This extension can still use `ctrl+r`; pi logs a non-fatal conflict warning and prefers the extension shortcut at the editor level.

To silence the warning while keeping reverse search on Ctrl+R, rebind rename in `~/.pi/agent/keybindings.json`:

```json
{
  "app.session.rename": "ctrl+shift+r"
}
```

Or change `searchShortcut` in `pi-input-history.json` to another chord.

## Features

- **Cross-session persistence** — history survives across sessions automatically.
- **Fuzzy subsequence matching** — type partial characters in order, multi-token support with spaces.
- **Minimal-span highlighting** — matched characters form the closest contiguous group, so `in` highlights `input`, not scattered chars.
- **Soft-wrapped preview** — long lines wrap to multiple lines instead of being truncated with `...`.
- **Adaptive viewport height** — the preview grows with content up to the terminal height, then scrolls.
- **Scrollable viewport** — `ctrl+k` / `ctrl+j` to browse the whole record.
- **Match markers** — the first matched line is marked with `▸`, separated by a dim divider.
- **Deduplication** — no duplicate entries across sessions.
- **Current session awareness** — merges live branch history with cached cross-session history.
- **Configurable shortcuts** — override via `pi-input-history.json`.
- **Skill-aware recall** — skill invocations are recalled as `/skill:name arguments`, not their expanded instructions.

## Development

Tests run on the Bun runtime embedded in the Pi executable. Set `PI_BIN` to the Pi 0.87.1 executable itself (the standalone binary at `$PI_PACKAGE_DIR/pi`, not a wrapper script), or set `PI_PACKAGE_DIR`:

```bash
npm run test:unit   # pure tests (bun:test)
npm run test:pi     # real Pi in a pseudo-terminal; needs Python 3 and git
npm test            # both
```

The Pi integration run uses a temporary HOME and agent directory with synthetic skills and sessions and starts Pi with `--offline`. No prompt reaches a real model: the one scenario that resubmits recalled commands uses Pi's local faux model. It checks Pi's version, compares session-file effects, startup time, and reverse-search keystroke cost with version 1.1.3 (read from git history), and fails rather than skipping when a prerequisite is missing. The large startup comparison writes a temporary synthetic session corpus of about 600 MB, and a full run takes a few minutes. Run it again whenever the supported Pi version changes.

## Acknowledgments

The reverse search component is inspired by [pi-readline-search](https://github.com/mrshu/pi-readline-search) by [@mrshu](https://github.com/mrshu).

## License

MIT
