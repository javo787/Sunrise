import nodemailer, { type Transporter } from "nodemailer";
import { mailConfig } from "@/lib/config";

export interface ReportMail {
  subject: string;
  text: string;
  html: string;
}

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!transporter) {
    const cfg = mailConfig();
    transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

export async function sendReportMail(mail: ReportMail): Promise<void> {
  const cfg = mailConfig();
  await getTransporter().sendMail({ from: cfg.SMTP_FROM, to: cfg.REPORT_EMAIL_TO.join(", "), subject: mail.subject, text: mail.text, html: mail.html });
}
