import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET } from "../../../worker/api/files/[...path]/route.ts";
import { allowFileRoot } from "../../../lib/allowed-roots.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-file-stream-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
allowFileRoot(root);

const bytes = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
fs.writeFileSync(path.join(root, "sample.bin"), bytes);

function request(name, type, headers = {}) {
  const segments = path.join(root, name).split(path.sep).filter(Boolean);
  return GET(new Request(`http://localhost/api/files/x?type=${type}`, { headers: { host: "localhost", ...headers } }), {
    params: Promise.resolve({ path: segments }),
  });
}

test("downloads send the full file without content-type sniffing", async () => {
  const response = await request("sample.bin", "download");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("inline SVG is served with a script-blocking content security policy", async () => {
  fs.writeFileSync(path.join(root, "sample.svg"), "<svg/>");
  const response = await request("sample.svg", "read");
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(await response.text(), "<svg/>");
});

test("a byte range resumes across chunks and stops at its inclusive end", async () => {
  const start = 123;
  const end = bytes.length - 456;
  const response = await request("sample.bin", "download", { range: `bytes=${start}-${end}` });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
});

test("a stalled download bounds disk read-ahead and cancellation closes the file", async () => {
  const createReadStream = fs.createReadStream;
  let stream;
  let stopped;
  let closed;
  fs.createReadStream = (...args) => {
    stream = createReadStream(...args);
    stopped = Promise.race([once(stream, "pause"), once(stream, "end")]);
    closed = once(stream, "close");
    return stream;
  };
  try {
    const response = await request("sample.bin", "download");
    assert.equal(response.status, 200);
    await stopped;
    assert.ok(stream.bytesRead > 0 && stream.bytesRead <= 2 * stream.readableHighWaterMark,
      `read ${stream.bytesRead} bytes without client demand`);
    await response.body.cancel();
    await closed;
    assert.ok(stream.closed);
  } finally {
    fs.createReadStream = createReadStream;
    stream?.destroy();
  }
});
