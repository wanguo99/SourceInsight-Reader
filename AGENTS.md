# Release versions

The current release package version is 1.1.0. During ordinary development, keep the current extension version unchanged. Update the version only when the user explicitly requests a release; use their specified version when provided. Keep package.json, the root package-lock.json version fields, installation instructions, and the latest changelog entry consistent. Do not change third-party dependency versions when updating the extension version. Do not move or overwrite an existing remote tag without explicit authorization.

The user asked to keep their pending edits uncommitted until they request a combined commit. Packaging and Marketplace publishing do not implicitly authorize a Git commit or push.

Before generating a release package, archive existing VSIX packages and their checksum/validation files under a timestamped dist/archive/ directory. Name new packages with the extension name and version only (for example wanguo-sourceinsight-reader-1.1.0.vsix); never append feature or fix names. Use npm run package so the archive step runs before building. Preserve archived package bytes and historical tags.
