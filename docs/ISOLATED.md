# Experimental isolated executor

The `src/isolated.ts` entry point runs tool calls in a second Pi process inside a Linux bubblewrap sandbox. The inner Pi uses no real model. A local OpenAI-compatible server supplies tool calls, and RPC returns results and supported dialogs.

The executor follows the two sandbox layers of `/permissions`. The read-only layer denies writes to host files. The no-network layer denies outbound IP traffic. A process boundary is fixed when the process starts, so each layer combination uses its own process.

This prototype is separate from the normal permissions extension. The default entry point stays unchanged.

## Start the prototype

Install Pi 1.5.2, bubblewrap, and Node.js 22.19 or newer on the Linux host. Make sure that `pi`, `bwrap`, and `node` are available through `PATH`.

From this repository, start the outer Pi with only the experimental extension:

```sh
pi --no-extensions --no-mcp -e ./src/isolated.ts
```

To load third-party extensions inside the sandbox, supply their paths as a JSON array:

```sh
pi --no-extensions --no-mcp -e ./src/isolated.ts \
  --inner-extensions '["/absolute/path/to/extension.ts"]'
```

Use `--inner-pi /absolute/path/to/pi` or `--inner-node /absolute/path/to/node` if the executables are absent from `PATH`.

Open `/permissions` in the outer Pi to turn the layers on and off. A change restarts the inner process with the new combination.

Do not load the original third-party extensions in the outer Pi. Their initialization code otherwise runs outside the sandbox. The prototype refuses to start while another extension registers host tools, but it cannot undo code that already ran.

## Follow the sandbox layers

The prototype reads the sandbox flags from the same state file as `/permissions`. End the Pi process and start the prototype with the normal entry point disabled.

| Layers | Result |
|---|---|
| read-only and no network off | Host tools answer. No inner process starts. |
| read-only on | Host files are read-only in the inner process. |
| no network on | Outbound IP traffic fails in the inner process. Host files are writable. |
| both on | Both restrictions apply in the same inner process. |

When you change a combination, the prototype stops the inner process and starts one that matches the new layers. The tool call that triggers the change waits for the new process. A call never runs on the host while a layer is on.

When every layer goes off, the prototype stops the inner process and the host tools answer again.

## Execution

Every host tool name becomes a delegate. With no layer, a delegate calls the host implementation. With a layer on, a delegate sends one tool call to the inner Pi and waits for the result and the `agent_settled` event.

The inner Pi starts in RPC mode with a private agent directory and an in-memory session. It loads no discovered extensions. The explicit paths from `--inner-extensions` select the extensions that it loads.

The server captures tool declarations from the first model request. RPC preserves the full result, including images, `details`, `structuredContent`, and the error flag. The outer extension forwards supported dialogs and notifications. It does not reproduce custom terminal components.

Calls execute one at a time. The protocol timeout does not run while a forwarded dialog waits for the user. A timeout in the other phases, cancellation, protocol failure, or child failure stops the executor. A later call starts a new process. The prototype never falls back to a host tool while a layer is on.

`/reload` stops the inner process and starts a new one. The layer combination also applies after the reload.

Commands that you type with `!` run on the host. The layers cover the tools that the model calls, as in the normal extension. Do not type a `!` command when you need the layer restrictions to apply.

## Boundary and limits

The no-network layer removes IP access. A relay inside the namespace connects the inner model endpoint to one host Unix socket. A Unix socket is a local process communication endpoint. The authenticated host server accepts only scripted model requests and does not forward network traffic.

The sandbox binds the host root and isolates process IDs. The read-only layer makes that root read-only and keeps private `/tmp`, `/run`, and `/dev` mounts writable. Read-only therefore protects host files, not every filesystem location inside the sandbox.

The root mount exposes readable host files, including credentials on disk. Unix sockets outside the masked directories remain accessible. A reachable host service can bypass the intended restrictions. This prototype is not a complete boundary for hostile extensions.

The inner environment excludes inherited API keys and Node loader variables. This does not hide credentials that remain readable through the filesystem. The prototype needs narrower filesystem mounts before use with untrusted code.

The control socket carries HTTP model requests. RPC uses standard input and output. An extension that corrupts those streams can stop the executor. The protocol is not a boundary against forged results from a hostile extension.

## Tests

Run the normal test suite from this repository:

```sh
npm test
```

To run the real Pi integration tests on a Linux host with bubblewrap, enable the live test flag:

```sh
PI_BRIDGE_LIVE_TEST=1 node --test src/isolated.integration.test.ts
```
