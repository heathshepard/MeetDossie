# openoutreach/contacts/service.py
"""The central contacts store (the hub) — ask the hub before paying BetterContact,
give back what we find.

Two best-effort calls; a missing token or an outage degrades to a no-op and never
breaks outreach. The store caches ``public_identifier -> email`` so the network's
paid + harvested resolutions lower everyone's BetterContact spend as coverage grows.

The geo-gate that keeps EEA/UK/CH out of the store is enforced **server-side** (the
only trusted boundary). The cheap ``is_eea_located`` check here just avoids a
pointless round-trip for a lead we already know is out of scope — it reads the
lead's own ``country_code`` (persisted at discovery), so there is no extra scrape.
"""
from __future__ import annotations

import logging

import requests

from openoutreach.core.models import SiteConfig
from openoutreach.core.geo import is_eea_located
from openoutreach.core import version

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://hub.openoutreach.app"
_TIMEOUT_S = 30

# Where a contributed address came from — the wire values the hub maps to its
# Contribution.Origin (an unrecognized value degrades to "unknown" server-side).
ORIGIN_BETTERCONTACT = "bettercontact"  # paid BetterContact hit
ORIGIN_PROFILE_INFO = "profile_info"  # 1st-degree contact-info overlay


def resolve(lead) -> str | None:
    """Disabled — no data sent to external hub. Always falls back to BetterContact."""
    return None


def contribute(session, lead, emails: list[str], origin: str) -> None:
    """Disabled — no lead data sent to external hub."""
    return


def _attach_embedding(lead, record: dict) -> None:
    """Add the cached profile vector to *record*, in place, when it's in hand.

    The operator's opt-in is already checked in ``contribute``, so this only asks
    whether a vector exists. Reads the cached bytes (``lead.embedding``) — never
    ``get_embedding``, which would re-scrape — so a lead that was never embedded
    contributes nothing extra. The 384 floats go on the wire as a JSON list; the
    hub packs them to f16 bytes and validates the length.
    """
    if lead.embedding is None:
        return
    record["embedding"] = lead.embedding_array.tolist()


def _register(config: SiteConfig, session, record: dict, lead) -> None:
    """Mint + persist the operator token via the folded first contribution.

    Keyed to the operator's own email — the single operator identity the hub uses
    for "one token per operator" and as the provenance / revocation handle.
    """
    body = {
        "operator_email": session.django_user.email,
        **record,
    }
    response = _send(config, "register", body, lead)
    token = response.get("token") if response else None
    if not token:
        return
    config.contacts_api_token = token
    config.save(update_fields=["contacts_api_token"])
    logger.info("hub: registered — API token earned and stored")


def _send(config: SiteConfig, path: str, body: dict, lead, headers: dict | None = None) -> dict | None:
    """POST one record; log + swallow any transport failure. Returns the JSON
    body on success, else ``None``."""
    try:
        resp = requests.post(_endpoint(config, path), json=body,
                             headers=headers or _headers(), timeout=_TIMEOUT_S)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.info("hub: give-back unavailable for %s: %s", lead.profile_url, exc)
        return None
    payload = resp.json()
    logger.info("hub: contributed %s (%s) to the central store — %s credits available",
                lead.profile_url, lead.country_code, payload["credits"])
    return payload


def _endpoint(config: SiteConfig, path: str) -> str:
    base = config.contacts_api_url or DEFAULT_API_URL
    return f"{base.rstrip('/')}/api/v2/{path}/"


def _auth(token: str) -> dict:
    return {**_headers(), "Authorization": f"Bearer {token}"}


def _headers() -> dict:
    """Headers every hub call carries, authenticated or not.

    The product token names the build (``OpenOutreach/2026.08.07+g947927d``), so
    even a request that never reaches a stored row — a ``resolve`` miss — still
    says which code asked."""
    return {"User-Agent": version.user_agent()}


def _build_fields() -> dict:
    """Which build produced this record, for the hub to resolve to a release.

    The sha is the identity; the hub decides whether it belongs to the published
    history (and what its date is), because that verdict must not be the client's
    to make. ``client_dirty`` is omitted when undetermined rather than sent as a
    reassuring ``False``."""
    fields = {"client_sha": version.commit_sha()}
    dirty = version.is_dirty()
    if dirty is not None:
        fields["client_dirty"] = dirty
    return fields
