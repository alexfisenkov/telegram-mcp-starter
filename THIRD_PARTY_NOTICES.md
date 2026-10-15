# Third-party notices

The maintained files under `runtime/files/dist/` contain code derived from
`@overpod/mcp-telegram` 1.43.1 (copyright 2025 overpod, MIT), plus extensions and
maintenance changes contributed to this project. The complete upstream MIT
notice is retained in `runtime/LICENSE`; this project's contributions use the
root `LICENSE`.

Upstream: https://github.com/mcp-telegram/mcp-telegram
Package: https://www.npmjs.com/package/@overpod/mcp-telegram/v/1.43.1

`tests/fixtures/upstream-preimages.json` is a compressed test fixture derived
from the same public upstream package and is covered by that upstream notice.
The fixture validates exact preimages; it is not a second runtime distribution.

Installed dependencies retain their own licenses and attribution in their npm
packages. Their exact versions and registry integrity values are pinned by
`package-lock.json`. `telegram` resolves to the `teleproto` package through the
explicit dependency override; browser automation uses Playwright. No credentials,
account sessions or private deployment configuration are part of this source.
