import { config } from '@/config/config';
import type { Payment } from '@/models/payment.model';
import type { Transaction, TransactionItem } from '@/models/transaction.model';
import type { Email } from '@/services/email.service';

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: config.store.currency }).format(
    cents / 100,
  );

const escape = (s: string) =>
  s
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    )
    // Encode non-ASCII characters as numeric entities for HTML-safe output.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7f]/gu, (c) => `&#${c.codePointAt(0)!};`);

/**
 * Order-placed confirmation. Written to the outbox inside the sale
 * transaction and delivered after commit (see outbox.service.ts).
 */
export function orderConfirmationEmail(
  to: string,
  sale: Pick<Transaction, 'reference' | 'totalCents'>,
  items: Pick<TransactionItem, 'name' | 'quantity' | 'lineTotalCents'>[],
): Email {
  const lines = items.map((i) => `${i.quantity} x ${i.name}  ${money(i.lineTotalCents)}`);
  const text = [
    `Thanks for your order, ${to}!`,
    '',
    `${config.store.name} — order ${sale.reference}`,
    '',
    ...lines,
    '',
    `Order total  ${money(sale.totalCents)}`,
    '',
    'We are preparing your order and will let you know when it is ready.',
  ].join('\n');
  return {
    to,
    subject: `Order ${sale.reference} received — ${config.store.name}`,
    text,
    html: `<pre style="font-family:ui-monospace,monospace;font-size:14px">${escape(text)}</pre>`,
  };
}

/** Plain-text and HTML receipt for a sale, mirroring the printed one. */
export function receiptEmail(
  to: string,
  sale: Transaction,
  items: TransactionItem[],
  payments: Payment[],
): Email {
  const lines = items.map((i) => `${i.quantity} x ${i.name}  ${money(i.lineTotalCents)}`);
  const paid = payments
    .filter((p) => p.status === 'completed')
    .map(
      (p) =>
        `${p.method.toUpperCase()}  ${money(p.amountCents)}${p.stellarTxHash ? `  (tx ${p.stellarTxHash})` : ''}`,
    );
  const text = [
    config.store.name,
    `Receipt ${sale.reference}  ${sale.createdAt} UTC`,
    '',
    ...lines,
    '',
    `Subtotal  ${money(sale.subtotalCents)}`,
    ...(sale.discountCents ? [`Discount  -${money(sale.discountCents)}`] : []),
    ...(sale.taxCents ? [`Tax  ${money(sale.taxCents)}`] : []),
    `Total  ${money(sale.totalCents)}`,
    '',
    ...paid,
    '',
    'Thank you',
  ].join('\n');
  return {
    to,
    subject: `Your receipt from ${config.store.name} (${sale.reference})`,
    text,
    html: `<pre style="font-family:ui-monospace,monospace;font-size:14px">${escape(text)}</pre>`,
  };
}
