export type ProjectName = 'shop' | 'billing'

interface ISourceFile {
  // Relative to the project directory.
  path: string
  // What a read of the file returns.
  content: string
}

export interface IProject {
  directory: string
  files: readonly ISourceFile[]
  branches: readonly string[]
}

// The invented people a template may name, always through a slot filled from this list.
export const CAST = ['Mira', 'Tomas', 'Priya', 'Jonah'] as const

export const PROJECTS: Record<ProjectName, IProject> = {
  shop: {
    directory: '/home/example/work/shop',
    files: [
      {
        path: 'package.json',
        content:
          '{\n  "name": "shop",\n  "private": true,\n  "scripts": { "test": "vitest run", "build": "vite build" }\n}\n',
      },
      {
        path: 'src/checkout/checkout-form.tsx',
        content:
          'import { CartSummary } from \'../cart/cart-summary\'\n\nexport const CheckoutForm = () => (\n  <form>\n    <CartSummary />\n    <button type="submit">Pay</button>\n  </form>\n)\n',
      },
      {
        path: 'src/checkout/discount.ts',
        content:
          'export interface IDiscount {\n  code: string\n  percent: number\n}\n\nexport const applyDiscount = (total: number, discount: IDiscount): number =>\n  Math.round(total * (100 - discount.percent)) / 100\n',
      },
      {
        path: 'src/cart/cart-total.ts',
        content:
          'export interface ILine {\n  price: number\n  quantity: number\n}\n\nexport const cartTotal = (lines: ILine[]): number =>\n  lines.reduce((sum, line) => sum + line.price * line.quantity, 0)\n',
      },
      {
        path: 'test/checkout/discount.test.ts',
        content:
          "import { expect, it } from 'vitest'\nimport { applyDiscount } from '../../src/checkout/discount'\n\nit('takes ten percent off', () => {\n  expect(applyDiscount(50, { code: 'TEN', percent: 10 })).toBe(45)\n})\n",
      },
      {
        path: 'README.md',
        content: '# shop\n\nThe storefront. Run `pnpm dev` and open http://localhost:5173.\n',
      },
    ],
    branches: ['main', 'feature/discount-codes', 'fix/cart-badge'],
  },
  billing: {
    directory: '/home/example/work/billing',
    files: [
      {
        path: 'pyproject.toml',
        content: '[project]\nname = "billing"\nversion = "2.2.0"\nrequires-python = ">=3.12"\n',
      },
      {
        path: 'billing/invoice.py',
        content:
          'from decimal import Decimal\n\nfrom billing.rounding import round_cents\n\n\ndef invoice_total(lines: list[tuple[Decimal, int]]) -> Decimal:\n    return round_cents(sum(price * quantity for price, quantity in lines))\n',
      },
      {
        path: 'billing/rounding.py',
        content:
          'from decimal import ROUND_HALF_UP, Decimal\n\n\ndef round_cents(amount: Decimal) -> Decimal:\n    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)\n',
      },
      {
        path: 'billing/late_fees.py',
        content:
          'from decimal import Decimal\n\nLATE_FEE = Decimal("5.00")\n\n\ndef with_late_fee(total: Decimal, days_late: int) -> Decimal:\n    return total + LATE_FEE if days_late > 0 else total\n',
      },
      {
        path: 'tests/test_invoice.py',
        content:
          'from decimal import Decimal\n\nfrom billing.invoice import invoice_total\n\n\ndef test_rounds_half_up():\n    assert invoice_total([(Decimal("0.125"), 1)]) == Decimal("0.13")\n',
      },
      {
        path: 'README.md',
        content: '# billing\n\nInvoices, taxes and late fees. Questions go to billing@example.com.\n',
      },
    ],
    branches: ['main', 'fix/invoice-rounding', 'chore/update-dependencies'],
  },
}
