# Tribune: customer feedback and feature voting for any website

A [Claude Code](https://claude.com/claude-code) skill that ships, installs and operates **Tribune**, a small self-hosted feedback board in the spirit of Canny or Fider. One instance serves many sites.

- Customers post ideas, vote once each, see similar ideas while typing, comment, follow.
- The team merges duplicates (reversibly), answers, changes statuses with a message that notifies the author, voters and followers, publishes a changelog linked to the ideas, and adds votes on behalf of customers from support tickets with their words and the ticket link.
- The backlog ranks ideas by weighted votes × impact × confidence ÷ effort, and shows people, accounts and monthly revenue (counted once per account) next to it.
- One line of script embeds it in any site; signed-in users are recognised through a short token signed by the site's server, so nobody creates a second account. Visitors can sign in with an emailed link.
- French, English and Spanish, light and dark, phone width, keyboard accessible. Export and erasure of personal data (GDPR, Quebec Law 25).

Node 22, PostgreSQL 14+ (its own container, or a `tribune` schema in an existing database or Supabase), Docker Compose. MIT.

## Install the skill

```bash
curl -fsSL https://raw.githubusercontent.com/koffih/claude-skill-tribune/main/install.sh | bash
```

Then ask Claude Code, for example: "add a feedback board with votes to my site", "ajoute Tribune sur le site", "what should we build next according to the votes".

## Run the service

```bash
cd service
cp .env.example .env    # set TRIBUNE_PUBLIC_URL, TRIBUNE_SECRET, POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec tribune node dist/server/cli.js create-site mysite "My site" --domains https://www.mysite.com
docker compose exec tribune node dist/server/cli.js admin-link mysite me@mysite.com
```

Embed: `<script src="https://<instance>/widget.js" data-site="mysite" async></script>`. Token signing examples for Node, Next.js, Supabase Edge Functions, Python and PHP are in [references/integration.md](references/integration.md).

## Tests

```bash
bash scripts/test-schema.sh   # schema applies twice on an empty PostgreSQL
bash scripts/test-api.sh      # 14 API rule tests (votes, merge, notifications, isolation, quotas, backlog, erasure, mail retries, webhook guard)
bash scripts/test-e2e.sh      # browser journey through a demo host page (Playwright), screenshots
bash scripts/test-docker.sh   # image build, compose start, health check
```

## Design

Built after reading the code of Fider, Quackback, Astuto, LogChimp, openheard, Chorala and Feedbackland and the documentation of the commercial leaders. What was taken from each, what was left out and why: [references/research.md](references/research.md). No code was copied from those projects.
