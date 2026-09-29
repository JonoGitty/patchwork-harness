# Contributing

Thanks for looking. A few house rules keep the harness trustworthy:

1. **Never a false VERIFIED.** No change may let a claim be marked verified without proof. The verifier exam (`PATCHWORK_HARNESS_VERIFIER_EXAM=strict npx vitest run tests/verifier-exam.test.ts tests/verifier-mutation.test.ts`) must stay green.
2. **Opt-in, not forced.** New harness behaviour ships behind a flag, with a decision record in [`DECISIONS/`](DECISIONS).
3. **Evidence over vibes.** Behaviour or model-routing changes should come with an eval (`patchwork-harness eval …`) or a test that fails without the change.
4. **Tests assert the positive.** Prove the thing happened, not merely that nothing bad was seen.

Before a PR:

```bash
npm ci
npm run typecheck
npm run build        # some tests drive the built CLI
npm test
```

Security issues: see [SECURITY.md](SECURITY.md). Please don't open public issues for vulnerabilities.
