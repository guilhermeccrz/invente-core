import assert from "node:assert/strict";
import test from "node:test";
import { renderNotice } from "../src/email/notify.js";
import { resendMailer } from "../src/email/resend.js";

test("aviso de job usa o texto da invente.ai", () => {
  const mail = renderNotice({ kind: "job_ready", to: "ana@invente.ai", jobId: "job1", link: "https://invente.ai/jobs/job1" });
  assert.equal(mail.to, "ana@invente.ai");
  assert.match(mail.subject, /invente\.ai/);
});

test("Resend recebe a chave e nao chama o GCP", async () => {
  let called = "";
  const mailer = resendMailer("re_test", "Invente <nao-responda@invente.ai>", async (url, init) => {
    called = String(url);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.to[0], "ana@invente.ai");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer re_test");
    return new Response("{}", { status: 200 });
  });
  await mailer.send({ to: "ana@invente.ai", subject: "oi", text: "texto" });
  assert.equal(called, "https://api.resend.com/emails");
});
