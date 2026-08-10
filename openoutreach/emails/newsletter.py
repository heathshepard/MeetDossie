# openoutreach/emails/newsletter.py
"""OpenOutreach newsletter subscription — a plain Brevo form POST.

Subscribes the operator's own email (their connected mailbox address) to the
OpenOutreach newsletter. Nothing here touches the retired channel: the subscription
was always an email signup; only the country-derived opt-in default and an optional
profile field used to ride along, and both are gone.
"""
from __future__ import annotations

import logging

import requests

logger = logging.getLogger(__name__)

BREVO_FORM_URL = (
    "https://efe1f107.sibforms.com/serve/"
    "MUIFAEobb1gQ5psA-rFpFReS5VDzoWB-F_AjgYiFptbn9xbYHTSTHDuaRi6gZc_gfhU_r-Qk2ap185L8eAWa6msNWiTmgrc2XClBiA4wQV0pt7J5m02hgTcr0-8v8D1HnWrWnFOa8gaQhJl6VTQySYCZ-JiseHI2ChmwIpkVrvZOMV3LfwQyeTB6TfWcKVzPeAHpCA8TvwCLTMfrjQ=="
)


def subscribe_to_newsletter(email: str) -> bool:
    """Disabled — no external newsletter signup."""
    return True
