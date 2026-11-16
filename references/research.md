# Research behind Tribune: what was taken from whom, and why

November 2026. Two Perplexity research runs (open-source landscape, then best practices of the commercial leaders), then a code reading of seven repositories. Raw material in `research/`:

- `perplexity-projets-open-source.md`: 26 self-hostable projects compared (stars, licence, stack, activity, features).
- `perplexity-bonnes-pratiques.md`: practices of Canny, Featurebase, Frill, Nolt, UserVoice, Productboard, Upvoty, Sleekplan, Userback, FeatureOS, UserJot.
- `dissection-quackback.md`, `dissection-fider-astuto.md`, `dissection-petits.md` (openheard, Chorala, Feedbackland, LogChimp): data model, identity, merge, ranking, notifications, webhooks, each claim with its file path.

No code was copied. Fider, Quackback, Astuto, openheard and LogChimp are AGPL (LogChimp partly proprietary); only ideas were taken. Tribune is MIT.

## Why build instead of installing Fider or Quackback

| Option | For | Against |
|---|---|---|
| Fider (4.6k stars, Go) | mature, multi-tenant | no identify-by-token for the widget, no widget, merge loses comments and subscribers, jobs held in memory (lost on restart), webhooks unsigned and never retried, AGPL |
| Quackback (360 stars, TS) | the most complete | one database per workspace, now a full support suite (inbox, help centre, status page), heavy to run for a dozen small sites, English-only full-text search, AGPL |
| Tribune (this) | one small service and one schema for every site, French first, fits the owner's stack (PostgreSQL, Supabase, Docker) | maintained by us |

## Taken, by source

| Idea | From | In Tribune |
|---|---|---|
| Similar ideas while typing the title, "vote instead" | Fider, Canny, FeatureOS | `GET /posts/similar`: trigram + full text on accent-free text, in the new-idea form |
| Signed short-lived token from the host server, no second account | Canny, Nolt, Frill, Chorala, Quackback | HS256, `iat` required, refused after one day (Quackback and Chorala skip expiry: their pitfall) |
| Bearer token inside the iframe, never a cookie | Quackback | the widget panel is an iframe, the session is a bearer token in the frame: third-party cookie blocking is irrelevant |
| Revenue counted once per company | Chorala, Canny MRR sort | `backlog_v.mrr` sums the MRR of distinct voting companies |
| Keep people, accounts, revenue and weighted votes as separate signals | Perplexity practices (UserVoice, Productboard) | Priorities tab shows all four next to the priority |
| RICE-like priority | Canny Ideas, practices | weighted votes × impact × confidence ÷ effort |
| Trending on recent activity, not creation date | Fider (30-day window), Feedbackland (half-life) | every vote decays by half each 14 days, comments count half; half-life shown on the portal |
| Merge must be reversible and keep everything | Quackback (link), openheard, Fider's failures | votes and comments move with `origin_post_id`, subscribers copied, unmerge moves them back, votes keep their original date |
| Status change is a public event with a message, notifies author, voters, followers | Canny, Astuto "official update" | `activity` row + notifications, message shown in the timeline and the email |
| Tenant-defined statuses with flags | Astuto, openheard "kinds" | per-site statuses with `on_roadmap`, `closes_votes`, `in_backlog`, `is_default` |
| Vote on behalf of a customer with their words and the ticket link | Canny (Zendesk), UserVoice, Nolt | `POST /posts/:n/votes` with `note`, `source_url`, company and MRR |
| Internal comments | Canny, Featurebase | `comment.internal`, filtered server side |
| Approval queue | Fider, Astuto, Upvoty | `board.require_approval`; pending posts visible to author and team only |
| Durable job queue | Fider's pitfall (in-memory) | notifications and webhook deliveries are rows, claimed atomically |
| Email digest when several updates arrive | missing in Quackback | notifications wait 2 minutes, then one email per person |
| Unsubscribe: GET shows, POST acts, one-click header | Quackback | signed stateless link, `List-Unsubscribe-Post` |
| Magic link consumed by a POST from the page | Fider's grace window for link scanners | opening the link does nothing; the page's script spends it |
| Webhooks signed, retried, blocked from private addresses | Quackback (Fider and Astuto do not sign) | HMAC-SHA256 over `timestamp.body`, backoff up to 8 attempts, private and link-local addresses refused at creation and at delivery, redirects not followed |
| Voters' emails never public | Astuto's leak | only the team sees emails, notes and companies |
| Counters kept by the database | Fider recounts on every list | triggers on `vote` and `comment` |
| `simple` text search + unaccent, not a fixed language | Quackback's English-only pitfall | one index works for French and English |
| Export and erase my data | Law 25, GDPR | `GET /me/export`, `DELETE /me` |

## Deliberately left out

- **Anonymous voting.** openheard's client-minted ids are trivially stuffed; Featurebase notes anonymous votes cannot be told about progress. Voting needs an identity (host token or email link). Revisit only with a keyed network hash and a fail-closed limit, as openheard's help-centre votes do.
- **Per-post language detection** (Fider): useful at scale, not needed with `simple` + unaccent + trigram for FR/EN.
- **Composite tenant foreign keys** (Fider): every query in Tribune filters by `site_id` and tests prove isolation; worth adding if third parties ever write SQL against the schema.

## Next steps, with their design

- **Semantic duplicates.** Quackback: full text and embeddings for recall, then an LLM asked to be conservative confirms at 0.75 or more; Chorala: cosine 0.86 with a local model. Never merge automatically: store suggestions for the team with a 30-day expiry. Use the instance owner's model gateway, never a client's keys without their agreement.
- **Requests from support.** Chorala and Featurebase: the model extracts requests from tickets as *pending* posts with their source, the team approves. Keep the customer's words as the vote `note`.
- **Weekly summary without AI** (openheard): ideas rising this week, planned ideas idle for 30 days, open ideas with no team reply. Cheap and actionable; send to moderators.
- **Canny CSV import** (openheard): create real vote rows, not a bare counter.
- **Attachments** (screenshots): store in the site's object storage, strip metadata, count against privacy notes.
- **MCP server** (openheard, Quackback) exposing triage to agents, with `confirm: true` on destructive tools.
