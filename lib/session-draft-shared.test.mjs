import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  hasSharedSessionDraftContent,
  parseSharedSessionDraftRequest,
  sameSharedSessionDraft,
  sessionDraftUrl,
  sharedSessionDraftId,
} = await jiti.import("./session-draft-shared.ts");

const PNG = { data: "aGk=", mimeType: "image/png" };

test("only saved-session keys are shareable", () => {
  assert.equal(sharedSessionDraftId("0f3c2a9e-7b1d"), "0f3c2a9e-7b1d");
  assert.equal(sharedSessionDraftId("new:draft-1:/home/elle/work"), null);
  assert.equal(sharedSessionDraftId("initial:/home/elle/work"), null);
  assert.equal(sharedSessionDraftId("parked-new:/home/elle/work"), null);
  assert.equal(sharedSessionDraftId("../secrets"), null);
  assert.equal(sharedSessionDraftId(""), null);
  assert.equal(sharedSessionDraftId(undefined), null);
});

test("session draft URLs encode the id", () => {
  assert.equal(sessionDraftUrl("abc.def"), "/api/sessions/abc.def/draft");
});

test("a draft counts as content when it has text or images", () => {
  assert.equal(hasSharedSessionDraftContent({ value: "", images: [] }), false);
  assert.equal(hasSharedSessionDraftContent({ value: " ", images: [] }), true);
  assert.equal(hasSharedSessionDraftContent({ value: "", images: [PNG] }), true);
});

test("content equality compares text and every image", () => {
  assert.equal(sameSharedSessionDraft({ value: "a", images: [PNG] }, { value: "a", images: [{ ...PNG }] }), true);
  assert.equal(sameSharedSessionDraft({ value: "a", images: [] }, { value: "b", images: [] }), false);
  assert.equal(sameSharedSessionDraft({ value: "a", images: [PNG] }, { value: "a", images: [] }), false);
  assert.equal(
    sameSharedSessionDraft({ value: "a", images: [PNG] }, { value: "a", images: [{ data: "aGk=", mimeType: "image/jpeg" }] }),
    false,
  );
});

test("parses a draft request and keeps only data and mimeType of each image", () => {
  const parsed = parseSharedSessionDraftRequest({
    value: "hello",
    images: [{ ...PNG, previewUrl: "blob:local-only" }],
  });
  assert.deepEqual(parsed, { ok: true, draft: { value: "hello", images: [PNG] } });
});

test("refuses malformed draft requests", () => {
  const invalid = [
    null,
    [],
    "text",
    { images: [] },
    { value: 1, images: [] },
    { value: "", images: "none" },
    { value: "", images: [{ data: "aGk=", mimeType: "text/plain" }] },
    { value: "", images: [{ data: "not base64!", mimeType: "image/png" }] },
    { value: "", images: Array.from({ length: 11 }, () => PNG) },
  ];
  for (const body of invalid) {
    const parsed = parseSharedSessionDraftRequest(body);
    assert.equal(parsed.ok, false, `expected refusal for ${JSON.stringify(body)}`);
    assert.equal(typeof parsed.error, "string");
  }
});
