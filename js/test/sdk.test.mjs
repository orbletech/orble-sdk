// Unit tests against a fake Orble API: what each call sends, and what it makes of the answers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { Orble, OrbleError } from "../dist/index.js";

let routes = {}; // "METHOD path" -> list of [status, body], used in turn
let seen = [];
let srv, orble;

before(async () => {
  srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const list = routes[`${req.method} ${req.url.split("?")[0]}`] ?? [[404, { error: "no such box" }]];
      const [status, out] = list.length > 1 ? list.shift() : list[0];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  orble = new Orble({ key: "k1", url: `http://127.0.0.1:${srv.address().port}` });
});
after(() => srv.close());
beforeEach(() => {
  routes = {};
  seen = [];
});
const json = (i) => JSON.parse(seen.at(i).body.toString());

test("create sends only what was given", async () => {
  routes["POST /v1/boxes"] = [[200, { name: "k7f2" }]];
  const box = await orble.create({ size: "m", fromSnapshot: "lab" });
  assert.equal(box.name, "k7f2");
  assert.deepEqual(json(-1), { size: "m", from: "lab" });
  assert.equal(seen.at(-1).auth, "Bearer k1");
});

test("exec waits for a long command", async () => {
  routes["POST /v1/boxes/k7f2/exec"] = [
    [200, { running: true, job: "j1", stdout: "a", stderr: "" }],
    [200, { exit_code: 2, stdout: "ab", stderr: "e" }],
  ];
  const r = await orble.box("k7f2").exec("make", { timeout: 90, env: { CI: "1" }, cwd: "app" });
  assert.deepEqual(r, { code: 2, stdout: "ab", stderr: "e", timedOut: false });
  assert.deepEqual(json(0), { command: "make", timeout_s: 90, env: { CI: "1" }, cwd: "app" });
  assert.deepEqual(json(1), { job: "j1" });
});

test("exec then delete", async () => {
  routes["POST /v1/boxes/k7f2/exec"] = [[200, { exit_code: 0, stdout: "", stderr: "" }]];
  await orble.box("k7f2").exec("make", { then: "delete" });
  assert.deepEqual(json(0), { command: "make", then: "delete" });
});

test("readBytes joins parts and decodes them", async () => {
  routes["GET /v1/boxes/k7f2/files"] = [
    [200, { size: 6, offset: 0, bytes: 3, encoding: "base64", content: Buffer.from([0, 1, 2]).toString("base64") }],
    [200, { size: 6, offset: 3, bytes: 3, encoding: "utf-8", content: "abc" }],
  ];
  const data = await orble.box("k7f2").readBytes("a b/f");
  assert.deepEqual([...data], [0, 1, 2, 97, 98, 99]);
  assert.equal(seen[0].url, "/v1/boxes/k7f2/files?path=a%20b%2Ff&offset=0");
  assert.equal(seen[1].url, "/v1/boxes/k7f2/files?path=a%20b%2Ff&offset=3");
});

test("write sends the bytes", async () => {
  routes["PUT /v1/boxes/k7f2/files"] = [[200, { bytes: 3 }]];
  await orble.box("k7f2").write("f", new Uint8Array([255, 0, 120]));
  assert.deepEqual([...seen.at(-1).body], [255, 0, 120]);
});

test("fork, snapshot and port", async () => {
  routes["POST /v1/boxes/k7f2/fork"] = [[200, { boxes: [{ name: "a1" }, { name: "a2" }] }]];
  routes["POST /v1/boxes/k7f2/snapshot"] = [[200, { name: "lab-start" }]];
  routes["PUT /v1/boxes/k7f2/ports/3000"] = [[200, { url: "https://3000-x.orble.tech" }]];
  const box = orble.box("k7f2");
  assert.deepEqual((await box.fork(2)).map((b) => b.name), ["a1", "a2"]);
  assert.deepEqual(json(-1), { count: 2 });
  assert.equal((await box.snapshot("lab-start")).name, "lab-start");
  assert.equal(await box.port(3000), "https://3000-x.orble.tech");
  assert.deepEqual(json(-1), { access: "private" });
});

test("errors carry the status and Orble's message", async () => {
  await assert.rejects(orble.box("nope").suspend(), (e) => e instanceof OrbleError && e.status === 404 && e.message === "404: no such box");
});

test("lists", async () => {
  routes["GET /v1/boxes"] = [[200, [{ name: "a" }, { name: "b" }]]];
  routes["GET /v1/snapshots"] = [[200, [{ name: "s" }]]];
  assert.deepEqual((await orble.boxes()).map((b) => b.name), ["a", "b"]);
  assert.deepEqual((await orble.snapshots()).map((s) => s.name), ["s"]);
});

test("no key", async () => {
  const saved = [process.env.ORBLE_API_KEY, process.env.XDG_CONFIG_HOME];
  delete process.env.ORBLE_API_KEY;
  process.env.XDG_CONFIG_HOME = "/nonexistent";
  try {
    await assert.rejects(new Orble().boxes(), OrbleError);
  } finally {
    if (saved[0]) process.env.ORBLE_API_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved[1];
  }
});
