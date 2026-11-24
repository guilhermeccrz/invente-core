export type RenderedMail = { subject: string; text: string; html: string };

export function verifyTemplate(link: string): RenderedMail {
  return layout({
    subject: "Confirme seu e-mail na invente.ai",
    title: "Confirme seu e-mail",
    text: `Confirme seu e-mail para entrar na invente.ai:\n${link}\n\nSe você não pediu isso, ignore esta mensagem.`,
    paragraphs: ["Falta um passo para entrar na invente.ai. O link expira em 24 horas."],
    action: "Confirmar e-mail",
    link,
    footnote: "Se você não criou uma conta, ignore este e-mail.",
  });
}

export function resetTemplate(link: string): RenderedMail {
  return layout({
    subject: "Redefina sua senha na invente.ai",
    title: "Escolha uma senha nova",
    text: `Para escolher uma senha nova, abra:\n${link}\n\nO link expira em uma hora.`,
    paragraphs: ["Recebemos um pedido para redefinir a senha da sua conta. O link expira em uma hora."],
    action: "Redefinir senha",
    link,
    footnote: "Se você não pediu isso, pode deixar este e-mail de lado. A senha atual continua valendo.",
  });
}

export function jobReadyTemplate(jobId: string, link: string): RenderedMail {
  return layout({
    subject: "Sua geração na invente.ai está pronta",
    title: "Sua geração está pronta",
    text: `O job ${jobId} terminou.\nAbra o resultado:\n${link}`,
    paragraphs: [`O job ${jobId} terminou e já está na sua galeria.`],
    action: "Abrir resultado",
    link,
    footnote: "O link da imagem ou do vídeo na API vale 15 minutos. A galeria gera outro quando você abrir de novo.",
  });
}

export function jobFailedTemplate(jobId: string, reason: string): RenderedMail {
  const safe = reason.replace(/[<>&]/g, "");
  return layout({
    subject: "Não conseguimos concluir sua geração na invente.ai",
    title: "A geração não foi concluída",
    text: `O job ${jobId} não foi concluído.\nMotivo: ${reason}\n\nOs tokens desta tentativa voltam para o saldo.`,
    paragraphs: [`O job ${jobId} não foi concluído.`, `Motivo: ${safe}.`, "Os tokens desta tentativa voltam para o saldo."],
    footnote: "Se o problema continuar, responda este e-mail.",
  });
}

function layout(input: { subject: string; title: string; text: string; paragraphs: string[]; action?: string; link?: string; footnote: string }): RenderedMail {
  const button = input.action && input.link
    ? `<p style="margin:28px 0"><a href="${escapeAttr(input.link)}" style="background:#e8ff47;color:#14140f;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:999px;display:inline-block">${escapeHtml(input.action)}</a></p><p style="word-break:break-all;color:#5c5a52;font-size:13px">${escapeHtml(input.link)}</p>`
    : "";
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f1e8;font-family:Georgia,serif;color:#14140f"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e8;padding:32px 12px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:520px;background:#fffdf8;border:1px solid #e4dcc8;border-radius:16px;padding:28px"><tr><td><p style="margin:0 0 8px;letter-spacing:.14em;text-transform:uppercase;font-family:Arial,sans-serif;font-size:12px">invente.ai</p><h1 style="font-size:28px;line-height:1.2;margin:0 0 16px">${escapeHtml(input.title)}</h1>${input.paragraphs.map((paragraph) => `<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${escapeHtml(paragraph)}</p>`).join("")}${button}<p style="margin:24px 0 0;color:#5c5a52;font-size:13px;line-height:1.4">${escapeHtml(input.footnote)}</p></td></tr></table></td></tr></table></body></html>`;
  return { subject: input.subject, text: input.text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] || char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
