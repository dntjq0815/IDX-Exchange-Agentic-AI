# IDX Exchange agent

This is the WhatsApp assistant for the California listing data. Weeks 1 through 5 get a message from a sentence, into MySQL, and back as a reply. Later weeks (embeddings, recommendations, RAG, email) are not in here yet.

The longer Week 1 notes, including the diagrams, are in [docs/week-01-architecture.md](docs/week-01-architecture.md).

OpenClaw already does the channel, the session routing, and the gateway. The code in this repo is the part that understands a housing question and reads the database.

## Data

Two tables, both in `idx_exchange`.

`rets_property` is what is for sale. Search uses it. `california_sold` is closed sales. Comps and the market answers come from that one. They join on `CAST(rets_property.L_ListingID AS UNSIGNED) = california_sold.ListingKey` when a later week needs both.

The handbook counts are about 228k active listings and 439k sold rows. The local import is smaller than that. Irvine, Pasadena, San Diego, Newport Beach, and a few other cities are enough to test with.

Credentials stay in `.env` (`MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`). Nothing in the scripts prints them. Queries are parameterized, and a search never returns more than 50 rows.

## Week 1

I wrote down the path before writing the skills: someone texts WhatsApp, OpenClaw picks a skill, the skill calls a tool, the tool hits MySQL, and the reply goes back out the same chat.

Session state (city, budget, the last question we asked) is separate from the embedding index. The index is a Week 6 problem. Email, when it shows up, is a draft the user has to approve. That is also later.

## Week 2

`parser.ts` turns a sentence into filters: city, max price, beds, baths, sqft, type, pool, view. It is regex, not a model. `week-02/sample-queries.ts` is the list of sentences and the filters I expect back. You need both files if you are checking the parser. To try one sentence yourself, only `parser.ts` has to run.

```bash
npm run parse -- "3-bedroom condos in Irvine under $1.5M with a pool"
```

With no argument it prompts for a sentence.

Price wording is loose on purpose. "under 1.2", "budget is 900k", and a message that is only "1200" all become a max price. A number under 10,000 with no k or m is treated as thousands, so 1200 is $1.2M and not $1,200. "1.2" with no suffix is millions. Condo, townhome, single family, and land map to the type strings in the table. The word "homes" does not. "Find homes in Irvine" should stay city-only, so the chat can still ask what kind of place they want.

## Week 3

`listings.ts` runs those filters against the real local database and prints a short card: address, price, beds and baths, photo count. Active listings only, city match is case-insensitive, cheapest first, 10 per page, hard stop at 50.

```bash
npm run search -- "condos in Newport Beach under $2M"
```

If the sentence is about sold homes or comps, it switches to `california_sold` for that city over the last 12 months. That path only uses the city. Beds, price, and type on a comps question are ignored. "Sold comps" and "sold homes" are the same query. Comps just means recent closed sales you would compare against.

Pool and view in this extract are stored as `"1"`, empty, or null. The parser says `True`. The search maps that to `"1"` before it hits SQL.

## Week 4

`chat.ts` is the conversation. It keeps the filters and asks for whatever is still missing, in this order: city, budget, then type ("condo, townhome, or single family"). "Any" or "no preference" skips the type filter.

```bash
npm run chat
```

A follow-up like "make it 3 beds" updates the same search instead of starting over. Changing the city does start over. If a message does not change any filter, it says so instead of printing the same list again. `clear`, `reset`, or `start over` drops the session. `quit` leaves the terminal chat.

The session is written to `.session-store.json` because a WhatsApp message starts a new process. That file is gitignored.

## Week 5

`market.ts` answers questions about a market, from `california_sold` over the trailing 12 months, plus a count of active listings. It runs before the property search, so "is it a good time to buy in Irvine?" does not turn into a listing hunt.

```bash
npm run market -- "Is it a good time to buy in Irvine?"
npm run market -- "average price per sqft in Pasadena"
```

It tries to answer the thing you asked. A timing question comes back as a yes, a wait, or a mixed answer, with the reason in the same sentence. A price-per-sqft question, average size, median, days on market, or inventory question stays on that number. A vague "how is the market" still gets the short summary. If the city is missing, the chat asks which city and then answers the original question.

The local sold rows in that 12-month window only cover part of the year, so a trend is first month to last month in the data, not a made-up full year.

## WhatsApp

`plugins/idx-agent` is the OpenClaw hook. On a WhatsApp message it runs `reply.ts`, which calls the same `handleMessage` as `npm run chat`. Replies are capped at 4,000 characters.

The linked number that should answer is the `agent` account. The personal number stays quiet. If both numbers run the agent, a reply lands on the other phone and gets answered again, and the two accounts talk to each other forever.

## Run it

Node 24. From this directory:

```bash
npm install
```

Put the MySQL settings in `.env`, then use `parse`, `search`, `chat`, or `market` as above. `search`, `chat`, and `market` load `.env` themselves.
