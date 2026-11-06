---
title: "Fix a flaky Playwright test"
source: "https://chat.deepseek.com/a/chat/s/test-chat"
exported: "2026-11-05T23:48:02.443Z"
messages: 4
summary_style: "standard"
model: "DeepSeek Reasoner"
exporter: "DeepSeek Chat Exporter 1.0.0"
---

# Fix a flaky Playwright test

> Exported from [DeepSeek](https://chat.deepseek.com/a/chat/s/test-chat) on **Nov 6, 2026** · **4** messages · **DeepSeek Reasoner**

_Local standard summary, generated entirely in your browser. The full transcript is included below._

## At a glance

- **You asked:** My Playwright test fails intermittently in CI with a timeout waiting for the checkout button. How can I make it reliable?
- **Bottom line:** Retries are a diagnostic tool, not a fix. They reduce noise while you investigate, but a test that fails 10% of the time will still fail in CI. Use retries temporarily with trace: 'on-first-retry', then fix the synchronization issue.
- **Topics:** test · retries · timeout · trace · api · button

## Key points

- Retries are a diagnostic tool, not a fix. They reduce noise while you investigate, but a test that fails 10% of the time will still fail in CI.
- Use retries temporarily with trace: 'on-first-retry', then fix the synchronization issue.
- Check the trace timeline for the first failure and compare it with a passing run.
- The timeout usually means the page is not finished hydrating when the click happens.
- Make sure the button is enabled and stable.
- Avoid waitForTimeout because it hides the real race.
- Wait for a user-visible signal rather than an arbitrary delay.
- Wait for the cart API response before clicking.

## Conversation outline

### 1. My Playwright test fails intermittently in CI with a timeout waiting for the checkout button. How can I make it…
- The timeout usually means the page is not finished hydrating when the click happens.

### 2. Should I use test retries instead of fixing the flake?
- Retries are a diagnostic tool, not a fix. They reduce noise while you investigate, but a test that fails 10% of the time will still fail in CI.

## Action items

- [ ] Use retries temporarily with trace: 'on-first-retry', then fix the synchronization issue.
- [ ] Check the trace timeline for the first failure and compare it with a passing run.
- [ ] Make sure the button is enabled and stable.
- [ ] Avoid waitForTimeout because it hides the real race.

## Code & files

- **Code:** 1 ts block
- **File:** [flaky-trace.zip](https://chat.deepseek.com/files/flaky-trace.zip)

## Links mentioned

- [Playwright docs: auto-waiting](https://playwright.dev/docs/actionability)
- [Playwright retries guide](https://playwright.dev/docs/test-retries)

## Full transcript

### You
_Apr 4, 2026, 10:13 AM_

My Playwright test fails intermittently in CI with a timeout waiting for the checkout button. How can I make it reliable?

---

### DeepSeek
_Apr 4, 2026, 10:13 AM_

<details>
<summary>Reasoning (70 characters)</summary>

I should check whether the cart response is the real readiness signal.

</details>

The timeout usually means the page is not finished hydrating when the click happens. Wait for a user-visible signal rather than an arbitrary delay.

Wait for the cart API response before clicking:

```ts
await page.waitForResponse(r => r.url().includes('/api/cart') && r.ok());
await page.getByRole('button', { name: 'Checkout' }).click();
```

Make sure the button is enabled and stable. Use `expect(locator).toBeEnabled()` before clicking. Avoid `waitForTimeout` because it hides the real race.

---

### You
_Apr 4, 2026, 10:13 AM_

Should I use test retries instead of fixing the flake?

- Attachment: [flaky-trace.zip](https://chat.deepseek.com/files/flaky-trace.zip)

---

### DeepSeek
_Apr 4, 2026, 10:15 AM_

<details>
<summary>Reasoning (66 characters)</summary>

Retries hide the signal, so explain that they are diagnostic only.

</details>

Retries are a diagnostic tool, not a fix. They reduce noise while you investigate, but a test that fails 10% of the time will still fail in CI.

Use retries temporarily with `trace: 'on-first-retry'`, then fix the synchronization issue. Check the trace timeline for the first failure and compare it with a passing run.

See the [Playwright retries guide](https://playwright.dev/docs/test-retries) for more details.


<!-- Generated locally by DeepSeek Chat Exporter. -->
