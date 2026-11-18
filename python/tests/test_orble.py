"""Unit tests against a fake Orble API: what each call sends, and what it makes of the answers."""
import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import orble


class Fake(BaseHTTPRequestHandler):
    routes = {}  # "METHOD path" -> list of (status, body) answers, used in turn
    seen = []

    def _serve(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        Fake.seen.append((self.command, self.path, body, self.headers.get("Authorization")))
        key = f"{self.command} {self.path.split('?')[0]}"
        answers = Fake.routes.get(key) or [(404, {"error": "no such box"})]
        status, out = answers.pop(0) if len(answers) > 1 else answers[0]
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = _serve

    def log_message(self, *a):
        pass


class SDK(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.c = orble.Client(key="k1", url=f"http://127.0.0.1:{cls.srv.server_port}")

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Fake.routes, Fake.seen = {}, []

    def last(self):
        m, p, b, auth = Fake.seen[-1]
        return m, p, json.loads(b) if b and b[:1] in b"{[" else b, auth

    def test_create_sends_only_what_was_given(self):
        Fake.routes["POST /v1/boxes"] = [(200, {"name": "k7f2", "state": "running"})]
        box = orble.create(size="m", from_snapshot="lab", client=self.c)
        self.assertEqual(box.name, "k7f2")
        self.assertEqual(self.last(), ("POST", "/v1/boxes", {"size": "m", "from": "lab"}, "Bearer k1"))

    def test_exec_waits_for_a_long_command(self):
        Fake.routes["POST /v1/boxes/k7f2/exec"] = [
            (200, {"running": True, "job": "j1", "stdout": "a", "stderr": ""}),
            (200, {"exit_code": 2, "stdout": "ab", "stderr": "e", "timed_out": False})]
        r = orble.Box("k7f2", self.c).exec("make", timeout=90, env={"CI": "1"}, cwd="app")
        self.assertEqual((r.code, r.stdout, r.stderr), (2, "ab", "e"))
        self.assertEqual(json.loads(Fake.seen[0][2]), {"command": "make", "timeout_s": 90, "env": {"CI": "1"}, "cwd": "app"})
        self.assertEqual(json.loads(Fake.seen[1][2]), {"job": "j1"})

    def test_exec_then_delete(self):
        Fake.routes["POST /v1/boxes/k7f2/exec"] = [(200, {"exit_code": 0, "stdout": "", "stderr": ""})]
        orble.Box("k7f2", self.c).exec("make", then="delete")
        self.assertEqual(json.loads(Fake.seen[0][2]), {"command": "make", "then": "delete"})

    def test_read_joins_parts_and_decodes(self):
        Fake.routes["GET /v1/boxes/k7f2/files"] = [
            (200, {"size": 6, "offset": 0, "bytes": 3, "encoding": "base64", "content": base64.b64encode(b"\x00\x01\x02").decode()}),
            (200, {"size": 6, "offset": 3, "bytes": 3, "encoding": "utf-8", "content": "abc"})]
        data = orble.Box("k7f2", self.c).read("a b/f", binary=True)
        self.assertEqual(data, b"\x00\x01\x02abc")
        self.assertEqual(Fake.seen[0][1], "/v1/boxes/k7f2/files?path=a%20b%2Ff&offset=0")
        self.assertEqual(Fake.seen[1][1], "/v1/boxes/k7f2/files?path=a%20b%2Ff&offset=3")

    def test_write_sends_the_bytes(self):
        Fake.routes["PUT /v1/boxes/k7f2/files"] = [(200, {"path": "f", "bytes": 3})]
        orble.Box("k7f2", self.c).write("f", b"\xff\x00x")
        self.assertEqual(Fake.seen[-1][2], b"\xff\x00x")

    def test_fork_snapshot_port(self):
        Fake.routes["POST /v1/boxes/k7f2/fork"] = [(200, {"boxes": [{"name": "a1"}, {"name": "a2"}]})]
        Fake.routes["POST /v1/boxes/k7f2/snapshot"] = [(200, {"name": "lab-start"})]
        Fake.routes["PUT /v1/boxes/k7f2/ports/3000"] = [(200, {"port": 3000, "url": "https://3000-x.orble.tech"})]
        box = orble.Box("k7f2", self.c)
        self.assertEqual([b.name for b in box.fork(2)], ["a1", "a2"])
        self.assertEqual(self.last()[2], {"count": 2})
        self.assertEqual(box.snapshot("lab-start").name, "lab-start")
        self.assertEqual(box.port(3000), "https://3000-x.orble.tech")
        self.assertEqual(self.last()[2], {"access": "private"})

    def test_errors_carry_status_and_message(self):
        with self.assertRaises(orble.Error) as e:
            orble.Box("nope", self.c).suspend()
        self.assertEqual((e.exception.status, e.exception.message), (404, "no such box"))

    def test_lists(self):
        Fake.routes["GET /v1/boxes"] = [(200, [{"name": "a"}, {"name": "b"}])]
        Fake.routes["GET /v1/snapshots"] = [(200, [{"name": "s"}])]
        self.assertEqual([b.name for b in orble.boxes(self.c)], ["a", "b"])
        self.assertEqual([s.name for s in orble.snapshots(self.c)], ["s"])

    def test_no_key(self):
        import os
        old = os.environ.pop("ORBLE_API_KEY", None), os.environ.get("XDG_CONFIG_HOME")
        os.environ["XDG_CONFIG_HOME"] = "/nonexistent"
        try:
            with self.assertRaises(orble.Error):
                orble.Client()
        finally:
            if old[0]:
                os.environ["ORBLE_API_KEY"] = old[0]
            if old[1] is None:
                os.environ.pop("XDG_CONFIG_HOME")
            else:
                os.environ["XDG_CONFIG_HOME"] = old[1]


if __name__ == "__main__":
    unittest.main()
