"""Orble: Linux boxes for agents, from Python. https://orble.tech/docs"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

__version__ = "0.1.2"
__all__ = ["Box", "Error", "Result", "Snapshot", "boxes", "create", "snapshots"]


class Error(Exception):
    """A request Orble refused or couldn't answer: status is the HTTP status (0 when no answer came)."""

    def __init__(self, status, message):
        super().__init__(f"{status}: {message}" if status else message)
        self.status, self.message = status, message


class Result:
    """What a command did: its exit code and output (the last 64 KiB of each stream)."""

    def __init__(self, code, stdout, stderr, timed_out=False):
        self.code, self.stdout, self.stderr, self.timed_out = code, stdout, stderr, timed_out

    def __repr__(self):
        return f"Result(code={self.code}, stdout={self.stdout!r}, stderr={self.stderr!r})"


def _config_dir():
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/orble")
    if os.name == "nt":
        return os.path.join(os.environ.get("APPDATA", ""), "orble")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "orble")


class Client:
    """Talks to Orble's API. The key comes from ORBLE_API_KEY, or else from the orble CLI's sign-in."""

    def __init__(self, key=None, url=None):
        cli = {}
        try:
            with open(os.path.join(_config_dir(), "config.json")) as f:
                cli = json.load(f)
        except (OSError, ValueError):
            pass
        self.key = key or os.environ.get("ORBLE_API_KEY") or cli.get("token")
        self.url = (url or os.environ.get("ORBLE_API_URL") or cli.get("api") or "https://orble.tech").rstrip("/")
        if not self.key:
            raise Error(0, "no API key: set ORBLE_API_KEY, or sign in with `orble login`")

    def call(self, method, path, body=None, raw=None, timeout=660):
        data, headers = None, {"Authorization": "Bearer " + self.key, "User-Agent": "orble-python/" + __version__}
        if raw is not None:
            data, headers["Content-Type"] = raw, "application/octet-stream"
        elif body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read()
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")
            try:
                msg = json.loads(msg).get("error") or msg
            except ValueError:
                pass
            raise Error(e.code, msg.strip() or e.reason) from None
        except urllib.error.URLError as e:
            raise Error(0, f"can't reach {self.url}: {e.reason}") from None
        return json.loads(text) if text else {}


_default = None


def _client():
    global _default
    if _default is None:
        _default = Client()
    return _default


def _q(s):
    return urllib.parse.quote(s, safe="")


class Box:
    """A box, by name. Box("api") is an existing one; create() makes a new one."""

    def __init__(self, name, client=None, info=None):
        self.name, self._c, self.info = name, client or _client(), info or {}

    def __repr__(self):
        return f"Box({self.name!r})"

    def _call(self, method, sub="", body=None, **kw):
        return self._c.call(method, f"/v1/boxes/{_q(self.name)}{sub}", body, **kw)

    def exec(self, command, timeout=None, env=None, cwd=None, then=None):
        """Run a shell command as the user agent, from /home/agent unless cwd says otherwise, and wait for it.
        then="delete" deletes the box when the command exits."""
        body = {"command": command}
        if timeout:
            body["timeout_s"] = int(timeout)
        if env:
            body["env"] = env
        if cwd:
            body["cwd"] = cwd
        if then:
            body["then"] = then
        r = self._call("POST", "/exec", body)
        while r.get("running"):  # a command still running after 50 s: wait for it again
            r = self._call("POST", "/exec", {"job": r["job"]})
        return Result(r.get("exit_code"), r.get("stdout", ""), r.get("stderr", ""), r.get("timed_out", False))

    def read(self, path, binary=False):
        """A file's content: text, or bytes with binary=True. Relative paths start at /home/agent."""
        out, offset = b"", 0
        while True:
            r = self._call("GET", f"/files?path={_q(path)}&offset={offset}")
            part = r["content"].encode() if r["encoding"] == "utf-8" else base64.b64decode(r["content"])
            out += part
            offset += r["bytes"]
            if not part or offset >= r["size"]:
                return out if binary else out.decode()

    def write(self, path, content):
        """Write a file (text or bytes), replacing it, with any missing directories."""
        data = content.encode() if isinstance(content, str) else bytes(content)
        self._call("PUT", f"/files?path={_q(path)}", raw=data)

    def port(self, port, public=False):
        """Share a port at its own https address and return it. Private ports open for your account only."""
        return self._call("PUT", f"/ports/{int(port)}", {"access": "public" if public else "private"})["url"]

    def fork(self, count=1):
        """Copies of the box as it is now, memory and running programs included."""
        r = self._call("POST", "/fork", {"count": count})
        if r.get("errors") and not r.get("boxes"):
            raise Error(0, "; ".join(r["errors"]))
        return [Box(b["name"], self._c, b) for b in r.get("boxes", [])]

    def snapshot(self, name=None):
        """Save the box as a snapshot, to make new boxes from later."""
        r = self._call("POST", "/snapshot", {"name": name} if name else {})
        return Snapshot(r["name"], self._c, r)

    def suspend(self):
        self.info = self._call("POST", "/suspend")

    def resume(self):
        self.info = self._call("POST", "/resume")

    def delete(self):
        self._call("DELETE")

    def refresh(self):
        self.info = self._call("GET")
        return self.info

    @property
    def state(self):
        return self.refresh()["state"]


class Snapshot:
    def __init__(self, name, client=None, info=None):
        self.name, self._c, self.info = name, client or _client(), info or {}

    def __repr__(self):
        return f"Snapshot({self.name!r})"

    def delete(self):
        self._c.call("DELETE", f"/v1/snapshots/{_q(self.name)}")


def create(size=None, name=None, from_snapshot=None, client=None):
    """Make a box: size s (the default), m or l; from_snapshot names a snapshot to start from."""
    c = client or _client()
    body = {k: v for k, v in {"size": size, "name": name, "from": from_snapshot}.items() if v}
    r = c.call("POST", "/v1/boxes", body)
    return Box(r["name"], c, r)


def boxes(client=None):
    c = client or _client()
    return [Box(b["name"], c, b) for b in c.call("GET", "/v1/boxes")]


def snapshots(client=None):
    c = client or _client()
    return [Snapshot(s["name"], c, s) for s in c.call("GET", "/v1/snapshots")]
