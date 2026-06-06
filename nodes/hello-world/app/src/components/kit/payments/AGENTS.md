# kit/payments · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Presentational UI components for USDC payment flow. Displays payment button, modal dialog for payment states, and background status indicator. Does not contain payment logic or state management.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [Payments Design](../../../../../../docs/spec/payments-design.md)
- [UI Implementation Guide](../../../../../../docs/spec/ui-implementation.md)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["shared", "types"],
  "must_not_import": [
    "app",
    "features",
    "core",
    "ports",
    "adapters",
    "bootstrap"
  ]
}
```

## Public Surface

- **Exports:**
  - `UsdcPaymentFlow` - Composed payment UI (button + dialog + chip)
  - `PaymentButton` - Simple button with idle/loading/disabled states
  - `PaymentFlowDialog` - Modal dialog for IN_FLIGHT/TERMINAL payment states
  - `PaymentStatusChip` - Background payment indicator when dialog closed
- **Types:** Component prop interfaces
- **Dependencies:** shadcn Dialog, lucide-react icons, shared/utils/money

## Component Architecture

```
UsdcPaymentFlow (composer)
├─ PaymentButton (always visible)
│  └─ States: idle | loading | disabled
├─ PaymentFlowDialog (modal, controlled)
│  ├─ IN_FLIGHT: spinner + step text + tx link
│  └─ TERMINAL: success/error alert + action button
└─ PaymentStatusChip (conditional)
   └─ Visible: txHash exists + dialog closed + payment in-flight
```

## Responsibilities

- This directory **does**: render payment UI driven by PaymentFlowState; manage local dialog open/close state; enforce dialog persistence in TERMINAL states; display user-friendly errors
- This directory **does not**: contain payment logic; call APIs; manage wagmi/web3 state; format money (uses shared/utils/money)

## Usage

```tsx
import { UsdcPaymentFlow } from "@/components/kit/payments/UsdcPaymentFlow";
import { usePaymentFlow } from "@/features/payments/public";

const flow = usePaymentFlow({ amountUsdCents: 1000, onSuccess: () => {} });
<UsdcPaymentFlow
  amountUsdCents={1000}
  state={flow.state}
  onStartPayment={flow.startPayment}
  onReset={flow.reset}
/>;
```

## Standards

- All components are client-side ("use client")
- State driven entirely by `PaymentFlowState` prop from `usePaymentFlow` hook
- Dialog dismissible in all active states; parent decides cancel (reset) vs close behavior
- Never renders raw viem/wagmi errors (uses formatPaymentError utility)
- Money formatting via shared/utils/money (no float math)
- Close when txHash===null triggers reset (cancel); close when txHash!==null preserves state

## Dependencies

- **Internal:** @/shared/utils/money, @/types/payments, @/components/vendor/shadcn
- **External:** lucide-react

## Change Protocol

- Update when component contracts change or new payment UI added
- Bump **Last reviewed** date
- Keep components presentational - no business logic

## Notes

- Transition-based auto-open prevents flash loops when user closes during on-chain
- Amount input disabled when txHash!==null OR result!==null (on-chain or terminal)
- PaymentStatusChip allows users to close dialog but monitor on-chain payments
