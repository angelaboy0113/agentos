# Requester mention notification implementation plan

**Goal:** Make every group conversation and final task outcome end with a real Feishu `@` notification to the person who initiated that message or task.

**Architecture:** Keep the existing live result card as the source of truth, then deliver a separate, idempotent plain-text reply after the terminal card is delivered. The reply uses the original message, original bot profile, and original profile-scoped sender ID, so a task may finish under another Agent without guessing or translating identity. `humanIdentities` remains the authorization mechanism for cross-Agent task controls.

**Tech stack:** Node.js 22, Feishu IM reply API / lark-cli, JSON durable outbox, built-in Node test runner.

---

### Task 1: Preserve requester and group origin

**Files:**
- Modify: `src/control-plane/conversations.js`
- Modify: `src/shared/store.js`
- Modify: `src/control-plane/server.js`
- Test: `test/conversations.test.js`

1. Persist `chatType` on each conversation turn.
2. Copy `originChatType` into newly created jobs and preserve it across stages.
3. Keep the original `senderId`, `originProfile`, and reply message unchanged during cross-Agent handoff.

### Task 2: Add an idempotent terminal mention to the card outbox

**Files:**
- Modify: `src/control-plane/live-cards.js`
- Modify: `src/control-plane/lark-cli.js`
- Modify: `src/control-plane/feishu.js`
- Test: `test/live-cards.test.js`

1. Accept a trusted `terminalMention` descriptor on a terminal card update.
2. Deliver `<at user_id="ou_xxx"></at>` only after the card result succeeds.
3. Persist the delivered mention revision so restart/retry cannot duplicate it.
4. Retry a failed mention without re-running Codex or creating a second task.
5. Validate identifiers and restrict this notification to group conversations.

### Task 3: Wire conversation and task outcomes

**Files:**
- Modify: `src/control-plane/conversations.js`
- Modify: `src/control-plane/server.js`
- Test: `test/live-cards.test.js`

1. Conversation completion replies to that exact question using its receiving Agent profile.
2. A truly terminal task (`completed`, `blocked`, `failed`, or `cancelled`, with no successor) replies to the original task message using the original Agent profile.
3. Intermediate handoffs and approval/clarification states do not announce completion.
4. The text-only fallback appends the native mention to the final response segment.

### Task 4: Verify, document, release, and restart

**Files:**
- Modify: `README.md`
- Modify: `docs/operations-and-data.md`
- Modify: `docs/documentation-sync.md`
- Modify: `package.json`

1. Run focused tests, then `npm test` and `npm run check`.
2. Restart the local AgentOS and verify `/health`.
3. Update the Feishu implementation document after verification.
4. Commit and publish a patch release without changing the existing `v1.0.0` tag.
