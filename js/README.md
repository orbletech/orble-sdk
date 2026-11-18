# Orble for TypeScript

Make Linux boxes for agents, run commands in them, fork them and save them, from TypeScript. Node 20+ and Bun.

```bash
npm install @orble/sdk
```

```ts
import { Orble } from "@orble/sdk";

const orble = new Orble();
const box = await orble.create();
console.log((await box.exec("echo hello")).stdout);
await box.delete();
```

## Run commands

```ts
const { code, stdout, stderr } = await box.exec("npm test", { cwd: "app", env: { CI: "1" }, timeout: 300 });
```

Commands run with `/bin/sh -c` as the user `agent` (passwordless sudo), from `/home/agent`. `exec` waits for the
command to finish, up to `timeout` seconds (at most 600). Each stream comes back as its last 64 KiB.

## Files

```ts
await box.write("app/config.json", '{"port": 3000}');
await box.read("app/config.json");
await box.write("logo.png", bytes);       // a Uint8Array
await box.readBytes("logo.png");
```

Relative paths start at `/home/agent`. `write` makes any missing directories. A file can have up to 8 MiB.

## Fork

```ts
const [a, b, c] = await box.fork(3);
```

Each copy has the box's files, memory and running programs as they were when you forked it.

## Snapshots

```ts
const snap = await box.snapshot("lab-start");
const lab = await orble.create({ fromSnapshot: "lab-start" });
await orble.snapshots();
```

## Suspend and resume

```ts
await box.suspend();
await box.resume();
```

Idle boxes suspend by themselves, and `exec`, `read` and `write` wake a suspended box.

## Ports

```ts
await box.exec("nohup python3 -m http.server 3000 > /dev/null 2>&1 &");
const url = await box.port(3000);                     // its https address, for your account only
const open = await box.port(3000, { public: true });  // for anyone with the address
```

Public ports need an account that has added credit.

## Boxes you have

```ts
await orble.boxes();
const box = orble.box("k7f2");
```

## Auth

The SDK reads an API key from `ORBLE_API_KEY`. Make one in [Settings](https://orble.tech/settings?tab=api). Without
it, the SDK uses the sign-in of the [orble CLI](https://orble.tech/docs?tab=cli) (`orble login`). Errors are
`OrbleError`, with the HTTP `status` and Orble's message.

## More

- [Docs](https://orble.tech/docs)
- [Python](https://pypi.org/project/orble-sdk/): `pip install orble-sdk`

## License

MIT
