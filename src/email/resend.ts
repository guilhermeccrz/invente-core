import type { Mail, Mailer } from "./notify.js";

const RESEND_URL = "https://api.resend.com/emails";

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(mail: Mail) {
      const response = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
        }),
      });
      if (!response.ok) throw new Error("resend_falhou");
    },
  };
}
