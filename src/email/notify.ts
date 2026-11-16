export type Mail = { to: string; subject: string; text: string };

export type Mailer = {
  send(mail: Mail): Promise<void>;
};

export type Notice =
  | { kind: "verify"; to: string; link: string }
  | { kind: "reset"; to: string; link: string }
  | { kind: "job_ready"; to: string; jobId: string; link: string }
  | { kind: "job_failed"; to: string; jobId: string; reason: string };

export function renderNotice(notice: Notice): Mail {
  switch (notice.kind) {
    case "verify":
      return {
        to: notice.to,
        subject: "Confirme seu e-mail na invente.ai",
        text: `Confirme seu e-mail para entrar na invente.ai:\n${notice.link}\n\nSe você não pediu isso, ignore esta mensagem.`,
      };
    case "reset":
      return {
        to: notice.to,
        subject: "Redefina sua senha na invente.ai",
        text: `Para escolher uma senha nova, abra:\n${notice.link}\n\nO link expira em uma hora.`,
      };
    case "job_ready":
      return {
        to: notice.to,
        subject: "Sua imagem na invente.ai está pronta",
        text: `O job ${notice.jobId} terminou.\nAbra o resultado:\n${notice.link}`,
      };
    case "job_failed":
      return {
        to: notice.to,
        subject: "Não conseguimos gerar sua imagem na invente.ai",
        text: `O job ${notice.jobId} não foi concluído.\nMotivo: ${notice.reason}`,
      };
  }
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
