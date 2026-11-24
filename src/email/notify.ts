import { jobFailedTemplate, jobReadyTemplate, resetTemplate, verifyTemplate } from "./templates.js";

export type Mail = { to: string; subject: string; text: string; html: string };

export type Mailer = {
  send(mail: Mail): Promise<void>;
};

export type Notice =
  | { kind: "verify"; to: string; link: string }
  | { kind: "reset"; to: string; link: string }
  | { kind: "job_ready"; to: string; jobId: string; link: string }
  | { kind: "job_failed"; to: string; jobId: string; reason: string };

export function renderNotice(notice: Notice): Mail {
  const rendered =
    notice.kind === "verify"
      ? verifyTemplate(notice.link)
      : notice.kind === "reset"
        ? resetTemplate(notice.link)
        : notice.kind === "job_ready"
          ? jobReadyTemplate(notice.jobId, notice.link)
          : jobFailedTemplate(notice.jobId, notice.reason);
  return { to: notice.to, ...rendered };
}

export async function notify(mailer: Mailer, notice: Notice): Promise<void> {
  await mailer.send(renderNotice(notice));
}

export class EmailNotConfigured extends Error {
  constructor() {
    super("email_not_configured");
  }
}

export function disabledMailer(): Mailer {
  return {
    async send() {
      throw new EmailNotConfigured();
    },
  };
}
