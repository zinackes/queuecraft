# Security Policy

## The one rule that matters

**Never expose the RCON port (default 25575) to the internet.** RCON authenticates with a
plaintext password and grants full console access to your server. Queuecraft is designed to
run next to the Minecraft server: bind RCON to `127.0.0.1` or keep it on an internal Docker
network, exactly as the provided compose files do. If you put RCON on a public interface,
anyone who sniffs or guesses the password owns your server.

Additional hardening:

- The RCON password must come from an environment variable — never commit a real one.
- The daemon only needs to *reach* RCON; it never needs to be reachable itself.
- Phase 2 interactivity uses `/trigger`, which any non-op player can fire. Only run it on
  servers where "anyone here may retry a job" is acceptable.

## Supported versions

Pre-1.0: only the latest release / `main` receives fixes.

## Reporting a vulnerability

Please use GitHub's **private security advisories** ("Report a vulnerability" on the repo)
rather than a public issue. You'll get an answer within a week. Low-severity hardening ideas
are fine as regular issues.
