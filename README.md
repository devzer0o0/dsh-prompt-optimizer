# Prompt Optimizer (提示词优化)

A DSH plugin that rewrites what you type into the composer into a precise
prompt **before** the model sees it, using one cheap side call on the session's
own route.

![Three panels showing a typed message, the agent/pre-step rewrite step, and the logged prompt that gets sent](docs/how-it-works.png)

The rewritten text is what enters the durable log, so the chat bubble and the
model always agree: you never see one thing and send another.

## Install

```sh
dsh plugin --profile <profile> add @feiyu999/dsh-prompt-optimizer
```

Or install the prebuilt tarball from the
[latest release](https://github.com/devzer0o0/dsh-prompt-optimizer/releases/latest)
through the app's plugin manager. No build step, no `allowBuilds` approval.

Also listed in the plugin catalog:
[awesome-dsh-plugin.com/p/devzer0o0/dsh-prompt-optimizer](https://awesome-dsh-plugin.com/p/devzer0o0/dsh-prompt-optimizer/).

## Turning it on

The switch is the whale in the composer's tool row
(`conversation.input.right`), between the model selector and Send.

![The composer tool row with the whale chip between the model selector and the Send button, and the hover panel showing a before/after rewrite](docs/composer.png)

Click it to toggle; the state lives in `~/.dsh/prompt-optimizer/state.json` and
survives a restart. Hover it to read the last before/after pair for the current
conversation.

### Two states

![Four cells: the whale as a dark silhouette when off, in gold when on, each shown at chip size and enlarged](docs/icon-states.png)

| state | rendering |
| --- | --- |
| **off** (default) | a dark silhouette used as a CSS mask over `currentColor`, so it carries **no fill colour of its own** and follows the host theme |
| **on** | the full-colour gold artwork |

Both states are inlined into `client.js` as data URIs. The chip is a 16px
control that must paint on the first frame, and a round trip per state would
flash an empty button. `assets/` keeps the source PNGs the constants are
generated from.

## What it does

While it is on, every message you send that looks like prose gets one
non-streaming call that turns it into a structured prompt: goal first, then the
constraints and acceptance criteria already implied by what you typed. Concrete
details — paths, names, numbers, error text — are preserved, chit-chat is
dropped, and the original language is kept.

## What it never touches

- Slash commands (`/compact`, …), messages shorter than `minChars`, messages
  longer than `maxInputChars`, and image-only messages.
- A message it already rewrote inside the same turn (identified by message id).
- Anything when the side call fails: a provider error, a timeout, or an empty
  rewrite sends the text exactly as you typed it, and the failure is logged as a
  warning (`dsh-prompt-optimizer: rewrite failed; …`).

## Where it hooks

`agent/pre-step` — the one waterfall that decides which messages enter a step.
`agent/request` is deliberately not used (the loop refuses message changes
there), and a request-side hook would rewrite a message already in the durable
log, so the transcript would disagree with the model.

The listener spreads the incoming decision (`{ ...decision, messages }`), so
fields such as `startsRequestSeries` and notices added by later listeners
survive.

## Configuration

`cordis.patch.yml` in this bundle is the only config surface:

```yaml
- insert:
    - id: prompt-optimizer
      name: dsh-prompt-optimizer
      config:
        enabled: false
```

The switch in the composer writes the state file, which wins over this row;
`enabled` here is just the initial posture. The rest of the knobs live in the
state file and can be edited by hand:

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | the switch |
| `provider` / `model` | `""` | pin the rewrite route; empty = the session's own route |
| `minChars` | `8` | shorter messages are sent untouched |
| `maxInputChars` | `6000` | longer messages are sent untouched |
| `maxOutputTokens` | `1200` | cap for the rewrite call |
| `timeoutMs` | `12000` | deadline for the rewrite call |
| `history` | `20` | how many rewrites the hover panel can read back |

## HTTP surface

`GET /prompt-optimizer/state[?sessionId=…]` → `{ ok, enabled, minChars, route, last }`

`POST /prompt-optimizer/state` with `{ "enabled": true }` → `{ ok, enabled }`

Both are served by the client half's toggle. There is no remote RPC: the route
is tiny and does not need one.

## Display

- Title / description: `locale/en.json`, `locale/zh.json` (`meta.title`,
  `meta.description`).
- Icon: `icon.png` (256×256, the gold whale on a dark tile), exported as
  `./icon`.

## License

MIT
