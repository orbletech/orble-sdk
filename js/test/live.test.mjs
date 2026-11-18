// End to end against a real Orble, opt-in: ORBLE_LIVE=1 with ORBLE_API_KEY (and ORBLE_API_URL for staging).
// It makes boxes and a snapshot under that key, and deletes them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Orble, OrbleError } from "../dist/index.js";

test("everything", { skip: process.env.ORBLE_LIVE !== "1" && "set ORBLE_LIVE=1", timeout: 600_000 }, async () => {
  const orble = new Orble();
  const made = [];
  let snap;
  const t0 = Date.now();
  const step = (what) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${what}`);
  try {
    const box = await orble.create({ size: "s" });
    made.push(box);
    step(`created ${box.name}`);
    let r = await box.exec("echo hi; echo oops >&2; exit 3");
    assert.deepEqual([r.code, r.stdout, r.stderr], [3, "hi\n", "oops\n"]);
    r = await box.exec('echo "$GREETING from $(pwd)"', { env: { GREETING: "hello" }, cwd: "/tmp" });
    assert.equal(r.stdout, "hello from /tmp\n");
    step("exec");
    await box.write("app/config.json", '{"port": 3000}');
    assert.equal(await box.read("app/config.json"), '{"port": 3000}');
    const blob = new Uint8Array(102400).map((_, i) => i % 256); // every byte value, more than one read
    await box.write("app/blob.bin", blob);
    assert.deepEqual(await box.readBytes("app/blob.bin"), blob);
    step("write and read");
    await box.exec("echo forked > /home/agent/mark");
    const [copy] = await box.fork(1);
    made.push(copy);
    assert.equal((await copy.exec("cat mark")).stdout, "forked\n");
    step(`forked ${copy.name}`);
    snap = await box.snapshot(`sdk-live-js-${Math.floor(t0 / 1000)}`);
    step(`snapshot ${snap.name}`);
    const again = await orble.create({ fromSnapshot: snap.name });
    made.push(again);
    assert.equal((await again.exec("cat mark")).stdout, "forked\n");
    step(`created ${again.name} from the snapshot`);
    await box.suspend();
    assert.equal((await box.refresh()).state, "suspended");
    await box.resume();
    assert.equal((await box.exec("cat app/config.json")).stdout, '{"port": 3000}');
    step("suspend and resume");
    await box.exec("nohup python3 -m http.server 3000 >/dev/null 2>&1 &");
    const url = await box.port(3000);
    assert.ok(url.startsWith("https://"), url);
    step(`port 3000 at ${url}`);
    assert.ok((await orble.boxes()).some((b) => b.name === box.name));
    assert.ok((await orble.snapshots()).some((s) => s.name === snap.name));
    await assert.rejects(orble.box("no-such-box").exec("true"), (e) => e instanceof OrbleError && e.status === 404);
  } finally {
    for (const b of made) await b.delete();
    if (snap) await snap.delete();
    step("deleted everything");
  }
});
