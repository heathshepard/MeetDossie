#!/usr/bin/env python3
"""
Speak text out loud through the PC speakers via ElevenLabs.

    python3 scripts/say.py "your text here"
    echo "your text" | python3 scripts/say.py

Built because reading long answers on screen is slower than hearing them.
Keep what you send here SHORT — a few sentences. Out loud, a wall of text is
worse than on screen, not better.

Key handling: ELEVENLABS_API_KEY is pulled from Vercel once and cached at
~/.elevenlabs_key (OUTSIDE this repo — it is public). Never write it into the
repo, and never pass it on a command line.

Requests raw PCM rather than mp3 so playback needs no codec: Python's stdlib
wave module adds the header, then PowerShell's SoundPlayer plays it and blocks
until it finishes.
"""
import os
import subprocess
import sys
import wave
import json
import urllib.request

VOICE = "lxYfHSkYm1EzQzGhdbfc"          # Luna
MODEL = "eleven_multilingual_v2"
RATE = 24000                             # pcm_24000 -> 24kHz 16-bit mono
KEYFILE = os.path.expanduser("~/.elevenlabs_key")
WAV_WSL = "/mnt/c/Users/Heath/AppData/Local/Temp/claude-say.wav"
WAV_WIN = r"C:\Users\Heath\AppData\Local\Temp\claude-say.wav"


def api_key():
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"].strip()
    if os.path.exists(KEYFILE):
        k = open(KEYFILE).read().strip()
        if k:
            return k
    # First run only: pull from Vercel and cache it outside the repo.
    #
    # npx resolves to the WINDOWS vercel binary, so an absolute WSL path is
    # reinterpreted as a Windows one: "/tmp/x" is written to C:\tmp\x, which
    # WSL sees at /mnt/c/tmp/x. It reports success either way, so the file
    # looks missing unless you know to look there.
    repo = "/mnt/c/Users/Heath/Projects/MeetDossie"
    subprocess.run(["npx", "vercel", "env", "pull", "/tmp/.env.eleven",
                    "--environment=production", "--yes"],
                   cwd=repo, check=True, capture_output=True)
    tmp = "/mnt/c/tmp/.env.eleven"
    key = ""
    for line in open(tmp):
        if line.startswith("ELEVENLABS_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip()
    os.remove(tmp)
    if not key or key == "[SENSITIVE]":
        sys.exit("could not read ELEVENLABS_API_KEY from Vercel")
    with open(KEYFILE, "w") as f:
        f.write(key)
    os.chmod(KEYFILE, 0o600)
    return key


def speak(text):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}"
        f"?output_format=pcm_{RATE}",
        data=json.dumps({"text": text, "model_id": MODEL}).encode(),
        headers={"xi-api-key": api_key(), "Content-Type": "application/json"})
    pcm = urllib.request.urlopen(req, timeout=120).read()

    with wave.open(WAV_WSL, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)

    subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                    f"(New-Object Media.SoundPlayer '{WAV_WIN}').PlaySync()"],
                   check=True, capture_output=True)


if __name__ == "__main__":
    body = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read()
    body = body.strip()
    if not body:
        sys.exit("nothing to say")
    speak(body)
