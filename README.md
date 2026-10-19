# DSH Approval Explainer

English | [中文](README.zh.md)

An AI annotator for the approval dialog in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

When the model asks to run something outside your workspace, `dsh` shows an approval prompt. This plugin adds an explanation next to the command, generated from the model's own reasoning: what the code does, what the model is trying to achieve, how risky it is and why, and what each button actually means.

<a id="install"></a>

## Install

```sh
dsh plugin --profile desktop add github:ArisuYuuko/dsh-approval-explainer
```

`desktop` is the profile the desktop app boots. The first use of a profile initializes it.

Then **fully quit and reopen DSH**. Reloading the page is not enough: the host half loads only at process start.

Verify the layer was installed:

```sh
dsh --profile desktop --dump-config
```

```yaml
# == dsh-approval-explainer
- id: dsh-approval-explainer
  name: dsh-approval-explainer
  inject:
    - llm
    - approval
```

This plugin is plain JavaScript with no build step, so pnpm does not ask you to authorize `allowBuilds`. See [Install notes](#install-notes).

To remove it, along with its configuration layer:

```sh
dsh plugin --profile desktop remove dsh-approval-explainer
```

<a id="what-it-does"></a>

## What it does

Without the plugin an approval prompt shows only the command:

```
即将执行
& '<temp>\diagnose-windows-sandbox-acl.ps1' -Path 'D:\some-project' -AllowRewrite
```

You have to work out what it does, what it touches, and what happens if you accept. If you cannot, you are choosing between trusting blindly and refusing blindly.

The plugin adds this to the same prompt:

```
Risk = medium (confidence high)

[What this code does]
  Writes ~300 words of acceptance notes to <output dir>\note.txt outside the
  workspace, using danger-full-access (cwd is <project dir>). The text itself
  only describes a timeout fix and its measurements.

[What the model is trying to achieve]
  You explicitly asked it to file an escalation request, so the model
  deliberately writes outside the workspace to trigger a real approval prompt
  and measure annotation latency.

[Why this risk level]
  The content is harmless and this is not production, but it explicitly asks
  for danger-full-access and targets a path outside the workspace. That falls
  under permission and security controls, so the standard rating is medium.

[Recommendation]
  Approve once: the content is harmless and matches your instruction, but let
  it through only this time rather than granting standing full-disk access.

[What each option means]
  Approve once -> the text is really written to <output dir>\note.txt and stays
                  on disk until you delete it; other writes under the same grant
                  are also allowed.
  Deny         -> nothing is written and the latency check cannot complete; the
                  model is told it was denied and may retry inside the workspace
                  or stop and ask you.
```

Note the last block. It does not just say "the command will run" — it says the file will really be created, that it can be deleted, and that other writes are covered by the same grant. That is the information a decision needs.

### Design notes

| | |
|---|---|
| **Only real approvals** | No annotations for routine tool calls. In one measurement `approval/request` fired 2 times while `tools/pre-execute` fired 259 — annotating everything is the same as annotating nothing |
| **Never blocks approval** | Generation runs in the background; the prompt appears immediately. A failure or timeout cannot affect what you may approve |
| **Failures are visible** | When generation fails the panel shows why instead of hanging silently |
| **Arguments come from the session** | Tool arguments are looked up by `callId` in the session log, with three fallbacks. If they cannot be found the annotation says so instead of inventing them |
| **Prompt-injection resistant** | The system prompt states that code, paths, and commands are data, not instructions |
| **Does not change policy** | It observes the approval waterfall; it does not decide who may be authorized |

<a id="how-it-works"></a>

## How it works

The plugin is a DSH **bundle**: an npm package carrying a `cordis.patch.yml` that contributes one configuration layer to a profile.

```
package.json        declares dsh.bundle.patch, pointing at the layer file
cordis.patch.yml    the layer: one insert row referencing the package by name
lib/index.js        host half (Node)
lib/client.js       browser half (Web)
```

The whole install mechanism is five lines of YAML:

```yaml
- insert:
    - id: dsh-approval-explainer
      name: dsh-approval-explainer     # by package name, so Node resolution finds the installed code
      inject:
        - llm
        - approval
```

`dsh plugin add` installs the package into the profile and, because the package declares `dsh.bundle`, appends it to `dsh.profile.bundles`. The effective config gains one layer.

### The two halves

```
lib/index.js   host half (Node)
               observes the approval/request waterfall, generates annotations in
               the background via the LLM, caches them, serves 8 HTTP routes

lib/client.js  browser half (Web)
               registers into the conversation.approval.detail slot and renders
               the command plus the annotation card
```

### Key decisions

**Only `approval/request` is hooked.** It is the only precise signal for "the user is being asked to decide something right now". An earlier version also hooked `tools/pre-execute` to pre-generate; the measured signal-to-noise was 259:2, where 259 routine operations drowned the 2 that mattered.

**Approval is never blocked.** The listener starts background generation and immediately `return next()`, handing the decision back to the real policy listener. So a successful, failed, or timed-out generation cannot affect what you may approve.

**Arguments are looked up in the session log.** The `approval/request` event carries **no tool arguments** (only `toolName`, `callId`, `reason`), so the plugin finds the `tool/call` event by `callId` with three fallbacks (`surface.nodes` → `snapshotEvents()` → `events`). When it cannot, the annotation says arguments are missing rather than inventing them.

**Shadowing the official renderer requires an explicit priority.** `conversation.approval.detail` is a **single** slot, and the official `dsh-client-ui-chat` already occupies `priority: 0`. Two registrations at the same priority in one slot is an error, and `entriesOfSlot` takes the first entry in **ascending** priority order — so shadowing requires a **lower** number (`-1`). The cost is having to re-render the command line yourself.

### Two hard constraints

**1. Never inject a client bundle yourself.** `dsh-client-modules` deduplicates by URL but rejects duplicate registrations by module id. If the host injects another `<script src=".../client.js">`, the browser half executes twice, web boot fails, and DSH runs its crash self-heal — which **removes profile config and disables every third-party plugin**. The startup graph loads the browser half; the host only serves routes.

**2. `apply()` must never throw.** Throwing marks the host fiber FAILED, the whole composition fails to mount, and the symptom is "DSH will not start after installing this". Every step in `apply()` is individually wrapped; any failure is recorded and execution continues.

<a id="history"></a>

## History

Every real escalation is recorded so you can look back at it later:

```
http://127.0.0.1:<dsh-web-port>/dsh-approval/history
```

**No URL to remember (v0.9.0).** The browser half adds an **Approval history** button to the Session header action row — the same row as the Conversation / Trajectory tabs (slot `conversation.session.header.actions`). Clicking it opens the page above in a new tab. The button is registered as a `list` entry with its own `id` and no `priority`, so it sits beside the other plugins that share that row (`agent-preset`, `job-list`, `schedule-catalog`, `agent-team`) without displacing any of them.

**Opened inside DSH, never in the system browser (v0.9.1 → v0.9.2).** The desktop shell serves the UI under the custom `dsh-app://app/` protocol, and its main process only hands **http(s)** targets to the system browser — every other new-window request is denied silently. A relative `/dsh-approval/history` therefore turned into `dsh-app://app/dsh-approval/history` and the button did nothing. Prefixing the host origin (`__DSH_TRANSPORT__.streamBaseUrl`) fixed the click, but it sent the page to the system browser — which is not what this is for. The button now opens **inside the app**: first the built-in sidebar browser tab (`sidebarRight.openTab('browser', { params: { url } })`, the same API DSH uses when `linkOpening` is `sidebar`), then same-window navigation over the current protocol. `window.open` and `target="_blank"` are gone from the client half.

The plugin stores **only its own annotations** (`<profile>/data/dsh-approval-explainer/annotations.jsonl`). The **decision** — allowed / rejected / cancelled — is read from DSH's own session log, where it already lives as paired `approval/asked` + `approval/decided` events. The two are joined by `callId`.

This split is deliberate: the host is the authority on who decided what, so duplicating it would only create a second version of the truth that drifts.

| Query | Meaning |
|---|---|
| (none) | HTML page |
| `?raw=1` | JSON |
| `?q=` | Keyword: tool / path / annotation / reason |
| `?decision=allow` | `allow` / `deny` / `cancel` / `pending` |
| `?risk=high` | `low` / `medium` / `high` |
| `?session=` | One session only |
| `?since=` / `?until=` | ISO time range |
| `?limit=` | Default 100, max 1000 |
| `?refresh=1` | Bypass the revision cache |

`POST /dsh-approval/history/clear` empties the annotation file. **It never touches DSH's session log.**

If DSH doesn't expose `sessionPersistence` (older host), the page still opens and says so — annotations remain readable, only the decision column is unavailable.

### Why the page has no framework

The page is server-rendered with zero client dependencies. This is a **diagnostic page**: its whole reason to exist is to still open when something is broken, so it must be sturdier than the thing it diagnoses. It doesn't need the browser half, a fetch call, or React.

<a id="diagnostics"></a>

## Diagnostics

```
http://127.0.0.1:<dsh-web-port>/dsh-approval/diag
```

`<dsh-web-port>` is the port the DSH web UI is currently serving on — it is chosen at runtime and changes across restarts, so don't hardcode it. Look at the URL of the DSH window itself.

A check page. Each item carries a conclusion and an action; raw data is folded at the end. Three output formats:

| Query | Output |
|---|---|
| (none) | HTML page for humans |
| `?raw=1` | Full JSON for scripts |
| `?format=text` | Plain text for curl |

The host also renders an annotation list at `/dsh-approval/view` without going through the browser half, so annotations remain inspectable even if the browser half misbehaves.

**Faster entry — no URL to type (v0.8.0).** The browser half registers a 🩺 **Plugin check** button at the sidebar foot (slot `sidebar.footer.action`). It reads `/dsh-approval/diag?raw=1` and lays the same conclusions out in a panel: verdict pill, checks, counters, browser-half status, crash and self-heal evidence, profile state, related-page links, and the raw JSON with a copy button. The panel refreshes every 10 s while open; `↻` re-checks immediately and `↗` opens the full page above. The version it shows is the one the **running host half** reports, so after bumping the package you must restart DSH before that number changes.

### Common problems

**No annotation in the prompt.** Check `/dsh-approval/client`. `registered: false` means the browser half never entered the startup graph; all three conditions must hold — the package is in the startup graph, `package.json` declares `dsh.client.platform === "web"`, and it exports `"./client"`.

**"Annotation could not be generated."** The panel footer states the reason: `annotation generation timed out` (40 s limit), `no model route available`, or `arguments missing`.

**Changes do not take effect.** `lib/index.js` is the host half — **restart DSH**. `lib/client.js` is the browser half — reloading the page suffices.

To tell which revision a running process loaded, compare the `moduleFingerprint` field of `/dsh-approval/diag?raw=1` with the sha256 of the file on disk. **Do not use file mtime** — any unrelated write moves it forward and the comparison silently flips.

<a id="configuration"></a>

## Configuration

**Not configurable through `cordis.yml` today.** The tunables are constants at the top of `lib/index.js`, each with a measured rationale:

| Constant | Default | Purpose |
|---|---|---|
| `GENERATE_TIMEOUT_MS` | 40000 | Generation deadline. Measured successes take 5–9 s |
| `ENTRY_TTL_MS` | 600000 | Annotation cache lifetime |
| `MAX_ARGS_CHARS` | 12000 | Tool-argument budget fed to the model |
| `MAX_REASONING_CHARS` | 4000 | Model reasoning budget |
| `MAX_ASSISTANT_TEXT_CHARS` | 2000 | Model answer budget |
| `MAX_ENTRIES` | 200 | Cache size cap |

### Why these are not config fields

The DSH documentation states a convention in [Plugin configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.zh.md):

> **No hardcoded tunables** — any value a deployment might need to change must be a config field.
> Test: can you change it in `cordis.yml` without editing code?

By that test all six should be exported as a Schemastery `Config` schema. They are not. This is a **known deviation**, and the reasons are measured rather than assumed:

1. **It requires resolving a peer dependency before `apply`.** Exporting `Config` needs `import Schema from '@deepseek-ai/schemastery'`, and that package does **not resolve** from the plugin's own directory (measured: `Cannot find module`). Only the host runtime's peer resolution can supply it.
2. **The import is evaluated before `apply`, so the plugin's `try`/`catch` cannot cover it.** A resolution failure is a module load failure and marks the fiber FAILED — the exact failure class behind this plugin's early crashes.
3. **The convention is a guideline, not a gate.** Of six installed bundles on the author's machine, one exports `Config`; the other five — including a mature 190 KB plugin — do not.

The practical impact is limited: all six defaults are measured and work unchanged. Editing the constants and restarting covers the need.

### One invariant if you edit them

`lib/client.js` polls `POLL_LIMIT` (120) × `POLL_INTERVAL_MS` (350 ms). That window must be **≥** `GENERATE_TIMEOUT_MS`, or the host is still generating while the panel has given up — the annotation is produced and thrown away while the user sees a failure.

> The nominal window is 42 s, but the loop requests before it sleeps, so the last request lands at 119 × 350 ms ≈ **41.65 s**. Change both values together.

<a id="security"></a>

## Security

**Trust fence.** Seven of the eight routes pass through a fence with three checks:

1. the `Host` header names a loopback address (`localhost`, `*.localhost`, `::1`, `127.0.0.0/8`)
2. `sec-fetch-site` is not `cross-site`
3. `Origin` is either `dsh-app:` or the same host as `Host`

**It does not check `req.socket.remoteAddress`** — the connection's source address is never inspected. This is not currently exploitable: DSH's web server binds `127.0.0.1` only, so no external source can reach the port, and a same-machine process already has local privileges and has no fence to bypass. If the server ever binds `0.0.0.0`, this gap becomes real and source checking must be added.

**Annotation text is untrusted.** It comes from the model and is HTML-escaped on render. The system prompt also tells the model that code and commands in the material are data, not instructions, to limit prompt injection.

<a id="install-notes"></a>

## Install notes

Measured by the author under an **isolated `DSH_HOME`**, so no real profile was touched:

```sh
$ dsh plugin --profile gh add github:ArisuYuuko/dsh-approval-explainer
+ dsh-approval-explainer github:ArisuYuuko/dsh-approval-explainer
Packages: +1
Done in 4.4s using pnpm v11.7.0

$ dsh --profile gh --dump-config
# == dsh-approval-explainer
- id: dsh-approval-explainer
  ...
```

The resulting `pnpm-workspace.yaml` contained **no `allowBuilds`** entry, confirming no manual authorization was required, and the seven installed files matched the repository byte for byte.

The [packaging and installing plugins](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md) guide notes that a git install fetches **source, not build output**, so TypeScript packages need a `prepare` script plus user authorization. This plugin ships plain JavaScript in `lib/`, so neither applies. If you are asked for `allowBuilds` during install, please open an issue — it would mean that reasoning is wrong.

Local paths and tarballs work through the same command, which is useful during development:

```sh
dsh plugin --profile desktop add ./dsh-approval-explainer
```

### Host compatibility

`package.json` declares the host range this plugin was built and tested against:

```json
"engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
```

The market shows this on the card, so a host that falls outside the range is flagged before install rather than after. It is a statement about what has been tested, not a guarantee that nothing else works.

Upgrading DSH is the one event most likely to break a plugin, because this plugin talks to host internals (`approval/request`, `ctx.llm.stream`, the `webServer` service, the `conversation.approval.detail` slot). After an upgrade, check `/dsh-approval/diag` first — it reports whether the host half loaded, whether the browser half entered the startup graph, and whether the profile config is intact.

<a id="development"></a>

## Development

```
lib/index.js        host half
lib/client.js       browser half
cordis.patch.yml    the bundle layer
package.json        package metadata and DSH declarations
```

### Verification

This plugin was built alongside a suite of checks, most of which do not need DSH running:

```sh
node verify-evaluate.mjs      # real ESM evaluation — catches reference errors node --check misses
node verify-http.mjs          # drives a real HTTP server through all 8 routes
node verify-semantics.mjs     # dead code, contract consistency, risky patterns
node verify-client-boot.mjs   # browser-half load contract
```

Suites using `vm.SourceTextModule` need `--experimental-vm-modules`.

Prefer real evaluation over text matching. This plugin was once broken by calling `fileURLToPath(import.meta.url)` when the identifier **was never imported**: the call always threw `ReferenceError`, an outer `catch` swallowed it, and the function returned null forever. The text assertion `source.includes('fileURLToPath(...)')` **passed**, because those characters were in the file. A text assertion and a working function are separated by an entire scope resolution.

<a id="license"></a>

## License

[MIT](LICENSE)
