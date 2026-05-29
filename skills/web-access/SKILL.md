---
name: "web-access"
description: "Strategy for web information tasks using fetch, local shell HTTP clients, and first-party source verification instead of a default search tool."
metadata:
  tags: ["web", "research", "verification"]
  triggers: ["web search", "current information", "external information", "URL fetch", "网页", "联网", "搜索"]
  version: "1"
  source: "native"
---

# Web Access

Use this skill for requests that need web information, page reading, current or external fact verification, source discovery, or URL content extraction.

## Operating Rules

1. Define the evidence target before browsing: what fact, date, version, price, policy, page content, or source is needed.
2. Prefer first-party or primary sources for conclusions. Search result pages are discovery inputs only, not proof.
3. If a URL is known, use `web_fetch` first. If `web_fetch` cannot reach it and shell is available, use a simple HTTP client such as `curl` or a small script only when it is appropriate for the active toolset.
4. If no web-capable tool is available in the active toolset, state that current web access is unavailable instead of pretending to have checked live information.
5. When using secondary discovery sources, follow through to the original source before making a final claim whenever the claim could affect user time, money, law, medicine, security, or release decisions.
6. Avoid repeating the same failing path. If one site, endpoint, or search page fails, change tactic or report the limitation with the exact failing route.

## Recommended Flow

1. Known URL: fetch the URL, extract the relevant claims, and cite the URL in the answer.
2. Unknown URL: discover candidate URLs through available non-default means, such as a specific site URL the user provided, official documentation indexes, package registries, GitHub repositories, or shell-accessible search pages if allowed.
3. Verification: compare dates, authorship, and source authority. Prefer official docs, release notes, standards, repositories, filings, or direct product pages.
4. Reporting: distinguish confirmed facts from inference. Include source links for any live or source-dependent answer.

## Boundaries

- This native skill replaces the old default `web_search` behavior. Do not assume a built-in search tool exists.
- Do not rely on DuckDuckGo fallback behavior; it is not part of the default runtime.
- Browser automation or CDP-based workflows are future opt-in extensions. They are not part of the default toolchain and should not be silently started by this skill.
