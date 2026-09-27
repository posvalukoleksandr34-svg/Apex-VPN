# Staging

A copy of production for trying releases and payments in Stripe's test mode. It uses the production templates:

```bash
bash env/generate.sh staging --domain staging.example.com
```

This writes `env/staging/*.env` with its own keys and `STRIPE_MODE=test`. Use a separate Supabase project, Cloudflare tunnel and Stripe test-mode keys. Run it with `bash deploy/app/stack.sh staging …`.
