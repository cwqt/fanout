# Webhooks

Fan-out webhooks to feature deployed branches - since we can't make webhooks on-the-fly for endpoints.
See <https://github.com/muxinc/mux-node-sdk/issues/12>

Makes no attempt to re-try requests, if a down-stream site fails, then tough luck.

```
    mux.com   stripe.com
       |         |
       v         v     Firebase serverless
  +----------------------------------+      +-----------+
  | webhooks.stageup.uk/(mux|stripe) + <--> | Firestore |
  +----------------------------------+      +-----------+
    |       |       |                       Look-up where to fan
    v       v       v                       out webhooks to
  su-345  su-145  su-778.stageup.uk
```

Has support for:

- [x] Mux
- [ ] Stripe (can use Terraform for this)

---

## Installation

```
npm install firebase -g
npm install --force
firebase login
```

## Contributing

Start Firebase development emulation server:

```
npm run start:firebase
```

Start code compilation watcher

```
npm run start:functions
```
