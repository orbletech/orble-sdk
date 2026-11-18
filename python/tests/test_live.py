"""End to end against a real Orble, opt-in: ORBLE_LIVE=1 with ORBLE_API_KEY (and ORBLE_API_URL for staging).
It makes boxes and a snapshot under that key, and deletes them."""
import os
import time
import unittest

import orble


@unittest.skipUnless(os.environ.get("ORBLE_LIVE") == "1", "set ORBLE_LIVE=1 to run against a real Orble")
class Live(unittest.TestCase):
    def test_everything(self):
        made, snap = [], None
        t0 = time.time()

        def step(what):
            print(f"  {time.time() - t0:6.1f}s  {what}", flush=True)

        try:
            box = orble.create(size="s")
            made.append(box)
            step(f"created {box.name}")
            r = box.exec("echo hi; echo oops >&2; exit 3")
            self.assertEqual((r.code, r.stdout, r.stderr), (3, "hi\n", "oops\n"))
            r = box.exec('echo "$GREETING from $(pwd)"', env={"GREETING": "hello"}, cwd="/tmp")
            self.assertEqual(r.stdout, "hello from /tmp\n")
            step("exec")
            box.write("app/config.json", '{"port": 3000}')
            self.assertEqual(box.read("app/config.json"), '{"port": 3000}')
            blob = bytes(range(256)) * 400  # 100 KiB of every byte value: more than one read
            box.write("app/blob.bin", blob)
            self.assertEqual(box.read("app/blob.bin", binary=True), blob)
            step("write and read")
            box.exec("echo forked > /home/agent/mark")
            (copy,) = box.fork(1)
            made.append(copy)
            self.assertEqual(copy.exec("cat mark").stdout, "forked\n")
            step(f"forked {copy.name}")
            snap = box.snapshot(f"sdk-live-py-{int(t0)}")
            step(f"snapshot {snap.name}")
            again = orble.create(from_snapshot=snap.name)
            made.append(again)
            self.assertEqual(again.exec("cat mark").stdout, "forked\n")
            step(f"created {again.name} from the snapshot")
            box.suspend()
            self.assertEqual(box.state, "suspended")
            box.resume()
            self.assertEqual(box.exec("cat app/config.json").stdout, '{"port": 3000}')
            step("suspend and resume")
            box.exec("nohup python3 -m http.server 3000 >/dev/null 2>&1 &")
            url = box.port(3000)
            self.assertTrue(url.startswith("https://"), url)
            step(f"port 3000 at {url}")
            self.assertIn(box.name, [b.name for b in orble.boxes()])
            self.assertIn(snap.name, [s.name for s in orble.snapshots()])
            with self.assertRaises(orble.Error) as e:
                orble.Box("no-such-box").exec("true")
            self.assertEqual(e.exception.status, 404)
        finally:
            for b in made:
                b.delete()
            if snap:
                snap.delete()
            step("deleted everything")


if __name__ == "__main__":
    unittest.main()
