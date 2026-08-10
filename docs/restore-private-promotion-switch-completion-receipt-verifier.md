# Restore Promotion Switch Completion Receipt Verifier

## Purpose

This read-only CLI authenticates an **already persisted** Restore Promotion Switch Completion Receipt without creating or modifying any restore evidence.

It exists so later workflows, especially online-update rollback recovery, can consume a single technical proof that a restore promotion completed only after the candidate volume set passed the established post-switch health contract.

## Verification chain

The command verifies the complete existing chain:

```text
HMAC-authenticated switch intent
  -> HMAC-verified durable switch journal
  -> HMAC-verified execution-event chain
  -> HMAC-verified promotion-switch completion receipt
```

The receipt is resolved only from the canonical execution-evidence directory as:

```text
promotion-switch-completion-receipt.json
```

A caller cannot provide a different receipt filename or unrelated receipt directory.

## CLI

```bash
RESTORE_PRIVATE_PROMOTION_SWITCH_INTENT_FILE=/absolute/path/promotion-switch-intent.json \
RESTORE_PRIVATE_PROMOTION_SWITCH_JOURNAL_FILE=/absolute/path/promotion-switch-journal.json \
RESTORE_PRIVATE_PROMOTION_SWITCH_EXECUTION_DIR=/absolute/path/switch-evidence \
RESTORE_PRIVATE_PROMOTION_INTENT_KEY_FILE=/absolute/path/restore-private-promotion.key \
pnpm --filter @masters/db backup:restore-promotion-switch-completion-receipt-verify
```

Successful output uses:

```text
mode=RESTORE_PROMOTION_SWITCH_COMPLETION_RECEIPT_VERIFICATION
status=VERIFIED
```

and returns only technical evidence identities required for downstream binding, including:

- receipt signature and completion timestamp,
- journal fingerprint/signature,
- candidate-set ID/fingerprint,
- `CANDIDATE_SELECTED` event signature,
- post-switch healthcheck fingerprint,
- healthy app/libSQL/background-service assertions,
- Caddy-preserved and rollback-volume-retained assertions,
- `productionMutationCompleted=true`,
- `promotionExecuted=true`.

## Safety boundary

The verifier is deliberately reader-only. It does not:

- create or update a completion receipt,
- write files or change permissions,
- invoke Docker or Docker Compose,
- stop/start services,
- mutate volumes,
- perform a backup restore,
- change an online-update event.

All cryptographic and evidence-binding checks are delegated to the same existing readers already used by restore completion and terminal assessment. No second implementation of the receipt HMAC protocol is introduced.

## Online-update rollback use

The Online Update Execution Plan requires a rollback receipt after any rollback. A future online-update rollback executor can reuse the already hardened restore/promotion pipeline to restore the exact journal-bound pre-update backup and then call this verifier.

The online-update rollback receipt can bind the returned authenticated restore-completion identity rather than duplicating restore receipt validation in Python.

This slice itself performs no rollback and does not authorize `ROLLBACK_COMPLETED`.
