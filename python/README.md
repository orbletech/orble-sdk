# Orble for Python

Make Linux boxes for agents, run commands in them, fork them and save them, from Python.

```bash
pip install orble-sdk
```

```python
import orble

box = orble.create()
print(box.exec("echo hello").stdout)
box.delete()
```

## Run commands

```python
r = box.exec("npm test", cwd="app", env={"CI": "1"}, timeout=300)
r.code, r.stdout, r.stderr
```

Commands run with `/bin/sh -c` as the user `agent` (passwordless sudo), from `/home/agent`. `exec` waits for the
command to finish, up to `timeout` seconds (at most 600). Each stream comes back as its last 64 KiB.

## Files

```python
box.write("app/config.json", '{"port": 3000}')
box.read("app/config.json")
box.write("logo.png", data)           # bytes too
box.read("logo.png", binary=True)
```

Relative paths start at `/home/agent`. `write` makes any missing directories. A file can have up to 8 MiB.

## Fork

```python
a, b, c = box.fork(3)
```

Each copy has the box's files, memory and running programs as they were when you forked it.

## Snapshots

```python
snap = box.snapshot("lab-start")
lab = orble.create(from_snapshot="lab-start")
orble.snapshots()
```

## Suspend and resume

```python
box.suspend()
box.resume()
```

Idle boxes suspend by themselves, and `exec`, `read` and `write` wake a suspended box.

## Ports

```python
box.exec("nohup python3 -m http.server 3000 > /dev/null 2>&1 &")
url = box.port(3000)                  # its https address, for your account only
url = box.port(3000, public=True)     # for anyone with the address
```

Public ports need an account that has added credit.

## Boxes you have

```python
orble.boxes()
box = orble.Box("k7f2")
```

## Auth

The SDK reads an API key from `ORBLE_API_KEY`. Make one in [Settings](https://orble.tech/settings?tab=api). Without
it, the SDK uses the sign-in of the [orble CLI](https://orble.tech/docs?tab=cli) (`orble login`). Errors are
`orble.Error`, with the HTTP `status` and Orble's `message`.

## More

- [Docs](https://orble.tech/docs)
- [TypeScript](https://www.npmjs.com/package/@orble/sdk): `npm install @orble/sdk`

## License

MIT
