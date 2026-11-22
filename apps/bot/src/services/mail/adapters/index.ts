import type { MailProviderAdapter, MailProviderType } from '../types.js';
import { AwsSesAdapter } from './awsSes.js';
import { ResendAdapter } from './resend.js';
import { SmtpAdapter } from './smtp.js';

const ADAPTERS: Record<MailProviderType, MailProviderAdapter> = {
  AWS_SES: new AwsSesAdapter(),
  RESEND: new ResendAdapter(),
  SMTP_IMAP: new SmtpAdapter(),
};

export function getMailAdapter(provider: MailProviderType): MailProviderAdapter {
  return ADAPTERS[provider];
}
