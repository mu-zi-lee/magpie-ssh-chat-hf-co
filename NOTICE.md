# Third-party notices

The cloudflared downloader and process supervisor are adapted from
mu-zi-lee/magpie-our-free-model (src/cloudflared-runtime.mjs and
src/owned-process.mjs), under the MIT license preserved in LICENSE.
The temporary tunnel launcher and login page integration are specific to this plugin.

The optional remote login downloads the official cloudflared 2026.10.0 release
from https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0.
Release sizes and SHA-256 digests are pinned; Darwin executables are also
checked after extraction. No binary is distributed in this repository.
The complete Apache-2.0 license is preserved in vendor/cloudflared/LICENSE
and copied into the private runtime cache beside downloaded cloudflared.
Source and third-party information:
https://github.com/cloudflare/cloudflared/tree/2026.10.0.
