/** Money for display. `Intl` accepts any well-formed 3-letter code (which
 *  the backend guarantees), rendering the code itself when it doesn't name
 *  a known currency — so an unusual code shows through rather than throwing. */
export function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}
