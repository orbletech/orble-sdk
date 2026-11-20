// Orble: Linux boxes for agents, from TypeScript. https://orble.tech/docs

export const version = "0.1.3";

/** A request Orble refused or couldn't answer: status is the HTTP status (0 when no answer came). */
export class OrbleError extends Error {
  constructor(public status: number, message: string) {
    super(status ? `${status}: ${message}` : message);
    this.name = "OrbleError";
  }
}

/** What a command did: its exit code and output (the last 64 KiB of each stream). */
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeout?: number; // seconds; at most 600
  env?: Record<string, string>;
  cwd?: string;
  then?: "delete"; // delete the box when the command exits
}

export interface CreateOptions {
  size?: "s" | "m" | "l";
  name?: string;
  fromSnapshot?: string;
}

const q = encodeURIComponent;

async function cliConfig(): Promise<{ token?: string; api?: string }> {
  if (typeof process === "undefined") return {};
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const dir =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "orble")
        : process.platform === "win32"
          ? join(process.env.APPDATA ?? "", "orble")
          : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "orble");
    return JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Talks to Orble's API. The key comes from ORBLE_API_KEY, or else from the orble CLI's sign-in. */
export class Orble {
  private ready: Promise<{ key: string; url: string }>;

  constructor(opts: { key?: string; url?: string } = {}) {
    const env = typeof process === "undefined" ? {} : process.env;
    this.ready = cliConfig().then((cli) => {
      const key = opts.key || env.ORBLE_API_KEY || cli.token;
      if (!key) throw new OrbleError(0, "no API key: set ORBLE_API_KEY, or sign in with `orble login`");
      const url = (opts.url || env.ORBLE_API_URL || cli.api || "https://orble.tech").replace(/\/+$/, "");
      return { key, url };
    });
  }

  /** One API call; the answer's JSON. */
  async call(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<any> {
    const { key, url } = await this.ready;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "User-Agent": `orble-js/${version}` };
    let data: BodyInit | undefined;
    if (raw) [data, headers["Content-Type"]] = [raw as BodyInit, "application/octet-stream"];
    else if (body !== undefined) [data, headers["Content-Type"]] = [JSON.stringify(body), "application/json"];
    let res: Response;
    try {
      res = await fetch(url + path, { method, headers, body: data });
    } catch (e) {
      throw new OrbleError(0, `can't reach ${url}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.trim() || res.statusText;
      try {
        msg = JSON.parse(text).error || msg;
      } catch {}
      throw new OrbleError(res.status, msg);
    }
    return text ? JSON.parse(text) : {};
  }

  /** Make a box: size s (the default), m or l; fromSnapshot names a snapshot to start from. */
  async create(opts: CreateOptions = {}): Promise<Box> {
    const body: Record<string, string> = {};
    if (opts.size) body.size = opts.size;
    if (opts.name) body.name = opts.name;
    if (opts.fromSnapshot) body.from = opts.fromSnapshot;
    const r = await this.call("POST", "/v1/boxes", body);
    return new Box(this, r.name, r);
  }

  /** An existing box, by name. */
  box(name: string): Box {
    return new Box(this, name);
  }

  async boxes(): Promise<Box[]> {
    return (await this.call("GET", "/v1/boxes")).map((b: any) => new Box(this, b.name, b));
  }

  async snapshots(): Promise<Snapshot[]> {
    return (await this.call("GET", "/v1/snapshots")).map((s: any) => new Snapshot(this, s.name, s));
  }
}

export class Box {
  constructor(private orble: Orble, public name: string, public info: any = {}) {}

  private call(method: string, sub = "", body?: unknown, raw?: Uint8Array) {
    return this.orble.call(method, `/v1/boxes/${q(this.name)}${sub}`, body, raw);
  }

  /** Run a shell command as the user agent, from /home/agent unless cwd says otherwise, and wait for it. */
  async exec(command: string, opts: ExecOptions = {}): Promise<Result> {
    const body: Record<string, unknown> = { command };
    if (opts.timeout) body.timeout_s = Math.round(opts.timeout);
    if (opts.env) body.env = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.then) body.then = opts.then;
    let r = await this.call("POST", "/exec", body);
    while (r.running) r = await this.call("POST", "/exec", { job: r.job }); // still running after 50 s
    return { code: r.exit_code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: !!r.timed_out };
  }

  /** A file's content as text. Relative paths start at /home/agent. */
  async read(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let offset = 0; ; ) {
      const r = await this.call("GET", `/files?path=${q(path)}&offset=${offset}`);
      const part =
        r.encoding === "utf-8" ? new TextEncoder().encode(r.content) : Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0));
      parts.push(part);
      offset += r.bytes;
      if (!part.length || offset >= r.size) break;
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) out.set(p, (at += p.length) - p.length);
    return out;
  }

  /** Write a file (text or bytes), replacing it, with any missing directories. */
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const raw = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.call("PUT", `/files?path=${q(path)}`, undefined, raw);
  }

  /** Share a port at its own https address and return it. Private ports open for your account only. */
  async port(port: number, opts: { public?: boolean } = {}): Promise<string> {
    return (await this.call("PUT", `/ports/${port}`, { access: opts.public ? "public" : "private" })).url;
  }

  /** Copies of the box as it is now, memory and running programs included. */
  async fork(count = 1): Promise<Box[]> {
    const r = await this.call("POST", "/fork", { count });
    if (r.errors?.length && !r.boxes?.length) throw new OrbleError(0, r.errors.join("; "));
    return (r.boxes ?? []).map((b: any) => new Box(this.orble, b.name, b));
  }

  /** Save the box as a snapshot, to make new boxes from later. */
  async snapshot(name?: string): Promise<Snapshot> {
    const r = await this.call("POST", "/snapshot", name ? { name } : {});
    return new Snapshot(this.orble, r.name, r);
  }

  async suspend(): Promise<void> {
    this.info = await this.call("POST", "/suspend");
  }

  /** Keep the box from suspending when it's idle (true, waking it if it's suspended), or let it suspend again (false). */
  async keepAwake(on = true): Promise<void> {
    this.info = await this.call("PATCH", "", { keep_awake: on });
  }

  async resume(): Promise<void> {
    this.info = await this.call("POST", "/resume");
  }

  async delete(): Promise<void> {
    await this.call("DELETE");
  }

  async refresh(): Promise<any> {
    return (this.info = await this.call("GET"));
  }
}

export class Snapshot {
  constructor(private orble: Orble, public name: string, public info: any = {}) {}

  async delete(): Promise<void> {
    await this.orble.call("DELETE", `/v1/snapshots/${q(this.name)}`);
  }
}
