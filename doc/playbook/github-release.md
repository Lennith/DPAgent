# GitHub Release Playbook

## Purpose

A GitHub Release publishes a reviewed source snapshot with visible CI evidence. It is separate from npm publication.

## Preconditions

- The release commit is on `main`.
- GitHub Actions CI is green for the commit.
- `CHANGELOG.md` has an entry for the version.
- Local runtime artifacts and private config are not staged.

## Local Verification

```bash
npm ci
npm run build
npm test
npm run build:web
```

For a full maintainer release candidate, also run:

```bash
npm run release:source-gate
```

## Create The Release

1. Create an annotated tag such as `v2.2.14` on the release commit.
2. Push the tag to GitHub.
3. Create a GitHub Release from that tag.
4. Paste the CI run link, release gate evidence paths if used, and the changelog notes.
5. Mark prereleases explicitly when the version contains a prerelease suffix.

## Evidence To Include

- Commit SHA.
- CI workflow URL.
- Version and tag.
- Local verification commands and results.
- Release gate evidence paths for maintainer releases.
- Notes about npm publication status, if any.
