# Historical: droidcode's API migrations

> **Status: archived.** This file used to be a forward-looking plan
> for migrating droidcode from the OpenCode REST API to the Rivet
> `sandbox-agent` TS SDK. Both endpoints are now obsolete:
>
> * The OpenCode→Rivet migration completed in droidcode in early
>   April 2026.
> * The Rivet→wagent migration completed in droidcode commit
>   `afc6631` ("migrate droidcode from Rivet SDK to wagent HTTP+SSE
>   client") on 2026-04-25.
>
> droidcode now talks to wagent's v1 HTTP+SSE wire directly — no
> SDK, no companion server. Current architecture lives in
> [droidcode/docs/ARCHITECTURE.md](https://github.com/sdelcore/droidcode/blob/main/docs/ARCHITECTURE.md).

Kept as a record of the path. The original migration body has been
removed; if you need it, `git log` this file pre-2026-04-26.
