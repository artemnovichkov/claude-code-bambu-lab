# CLAUDE.md

A Claude Code plugin ("mod") named `bambu`: a pane beside the chat showing a Bambu Lab printer's live status from Bambu Lab's cloud. Published at https://github.com/artemnovichkov/claude-code-bambu-lab, MIT. The repository is its own marketplace (`.claude-plugin/marketplace.json`, source `./`).

## Layout

- `hooks/register.tsx`: the hooks module. Opens the `bambu` pane, registers `/bambu [sign-in | sign-out | refresh]`, spawns the bridge for the session's life (restarts it up to 20 times) and draws the pane on every surface: `Image` on the terminal, `Svg` with an embedded PNG elsewhere.
- `bridge/bridge.py`: Python 3, standard library only (macOS's python3). Cloud API, sign-in, MQTT, the view model.
- `types/index.d.ts`: `PrinterView` (the bridge's JSON) and the `$.state` contract (`bambu.view`, `bambu.commands`, `bambu.confirm`).
- `tests/pane.test.tsx`: `claude plugin test` tests; they stand in for `process.spawn`, `fs.*`, `ui.*`.
- `.claude-plugin/plugin.json`: manifest, `userConfig` (`region`, `printer`, `pane`).

## How the two halves talk

- The mod runs `python3 -I bridge/bridge.py` with stdin closed and env `BAMBU_REGION`, `BAMBU_PRINTER` from `userConfig`.
- Bridge → mod: stdout JSON lines: `{"view": PrinterView, "commands": "<dir>"}` on every change (at most 1/s, at least every 30 s), `{"toast"}` / `{"error"}` after a command. `commands` rides on every view on purpose: a mod that missed the first line still learns it.
- Mod → bridge: JSON files `{"cmd": ...}` written into `~/Library/Application Support/claude-bambu/commands/`, polled every 0.4 s. Commands: `sign-in`, `sign-out`, `refresh`, `light`, `pause`, `resume`, `stop`.
- Keep the two in step: a field added to the view goes into `build_view()` and `PrinterView`.

## Bridge facts

- Sign-in runs macOS `osascript` dialogs from the bridge (password field hidden), so the password never crosses the mod and is never stored. Handles password, emailed code (`loginType: verifyCode`) and authenticator (`tfa`, tokens in cookies from `bambulab.com/api/sign-in/tfa`).
- Tokens: Keychain service `claude-bambu`, accounts `access` / `refresh`, written through `security -i` so they never appear in `ps`. A 401 first re-reads the Keychain (another session's bridge may have renewed), then trades the refresh token.
- MQTT 3.1.1, QoS 0, own client over TLS to `us.mqtt.bambulab.com:8883` (`cn.` for china), user `u_<uid>`, password the access token. Subscribes `device/<serial>/report`, publishes to `device/<serial>/request`, sends `pushall` on connect and after 5 quiet minutes. Partial reports merge into the full one (`merge()`: lists of `{"id"}` entries merge by id).
- Newer firmware (P2S) packs temperatures as `target << 16 | current` under `device.extruder/bed/ctc.info.temp`; older fields are the fallback.
- Requests carry slicer-style headers (`X-BBL-Client-*`); Bambu's API answers slicers. Documented as a known limit in the README.
- Data lives in `~/Library/Application Support/claude-bambu/` (`state.json`, `covers/`, `hms-tables.json` (HMS wording per printer type: the serial's first three characters as `d=`), `bridge.log`). The log never holds tokens, passwords or serials: keep it that way.
- Plate covers: downloaded, `sips -Z 320`, cropped to the opaque area by the bridge's own PNG decoder (`png_pixels`).

## Rules

- Never copy code from the visor `bambu` plugin (third-party, unlicensed). This bridge was written from scratch; keep it that way.
- Standard library only in the bridge; macOS only.
- Keep the README's "not affiliated with Bambu Lab or Anthropic" disclaimer, and use no logos.
- No personal data in tests or fixtures (printer names, serials, real print names).
- Commit messages: short.

## Develop and check

```sh
claude plugin validate .
claude plugin test .
BAMBU_FIXTURE=<file.jsonl> python3 -I bridge/bridge.py </dev/null   # recorded MQTT messages, one per line
```

Release: bump `version` in `plugin.json`, add a `## <version> - <date>` section on top of `CHANGELOG.md`, commit, push tag `v<version>`. `.github/workflows/release.yml` fails if the tag and `plugin.json` disagree or the section is missing, else publishes the release with that section as notes.

Run the mod from this folder with `claude --plugin-dir ~/Developer/claude-code-bambu-lab` (desktop: `CLAUDE_CODE_PLUGIN_DIRS`). Don't also have the installed copy enabled, or the session gets two panes and two bridges. Hooks-module rules that bite: a function that takes `$` must be declared at the top of the file; `$.process.spawn` gives no stdin, hence the command files. The engine writes the API types to `.claude-plugin/types/` (gitignored) on load; `tsconfig.json` extends them for `tsc -p .`.
