# Context — domain glossary

Canonical meaning of terms used across this repo's specs, plans and code.
Definitions only. No implementation detail — that belongs in `docs/specs/`.

## Replay

**Visual replay** — a recording of a match as the site itself rendered it, captured as an
rrweb event stream. The only kind of replay; there is no structured replay.

**Keyframe** — an rrweb full snapshot. A seek target.

**Viewer core** — the playback engine that turns `{meta, events}` into a running replay in a
container. Knows nothing about the dashboard or about sharing.

**Chrome** — the UI wrapped around a viewer core: controls, chapter chips, banners, modal or
page furniture. The dashboard and the share viewer have different chrome and the same core.

**CSS rehydration** — restoring stylesheet text that was replaced by a content-hash reference
at capture time. A replay cannot render correctly until it has happened.

## Sharing

**Share** — one encrypted replay published to an instance, addressed by an object id, readable
by anyone holding its link, and deleted when its TTL elapses.

**Instance** — one deployment of the share Worker together with its R2 bucket. Whoever deploys
an instance owns its storage, its bill and its abuse exposure.

**Share endpoint** — the base URL of the instance an extension uploads to. A public URL, not a
secret. Configurable, because self-hosting is a first-class path.

**Link** — the URL handed to a recipient. Carries the object id and the decryption key in its
fragment, so neither reaches the instance's request logs.

**Payload** — the replay content that gets shared: metadata, events and CSS assets, before any
compression or encryption.

**Frame** — the byte layout wrapping an encrypted payload: magic, flags, IV, ciphertext, tag.
What "corrupt frame" and "not a replay" are distinguished by.

**Kill switch** — a flag that disables an instance's uploads without redeploying it.

**Takedown** — an instance operator deleting one object by hand. The only way a share ends
early; there is no user-facing revocation, by design.

**TTL** — how long a share survives before deletion. Bounds storage cost and privacy exposure
at the same time.

**Self-host** — deploying your own instance from a clean checkout. A supported path, not a
workaround.
