#!/usr/bin/env python3
"""Add local VOICEVOX Nemo narration to the preserved Goal014 movie.

Python standard library + ffmpeg/ffprobe; a separately installed official Nemo
engine must already be listening on 127.0.0.1. Never downloads or starts an engine,
contacts a cloud API, changes the application, or replaces an existing output.
"""
import argparse
import array
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request
import wave

SOURCE_SHA256 = "592c3df09739a6e81b91d5926747b2d343bbfbf1d63e2841b0420e1eaed6e59c"
RATE = 48000
SETTINGS = dict(speedScale=1.0, pitchScale=0.0, intonationScale=1.0,
                volumeScale=1.0, prePhonemeLength=0.18,
                postPhonemeLength=0.25, outputSamplingRate=RATE,
                outputStereo=False)
SAMPLE = "うごく紙工房。自分の絵から、原寸の型紙を作ります。"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    with Path(path).open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")


def ffmpeg(*args):
    return subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats",
                           "-n", *map(str, args)], check=True, capture_output=True,
                          text=True).stderr


def request(origin, path, parameters=None, body=None, method="GET"):
    url = origin + path
    if parameters:
        url += "?" + urllib.parse.urlencode(parameters)
    req = urllib.request.Request(url, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    # No redirects, proxies, alternate providers, or credential discovery.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            raise RuntimeError("Local engine redirect refused")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(req, timeout=180) as response:
        return response.read()


def pcm(path):
    with wave.open(str(path), "rb") as file:
        assert file.getnchannels() == 1 and file.getsampwidth() == 2
        assert file.getframerate() == RATE
        result = array.array("h", file.readframes(file.getnframes()))
    if sys.byteorder != "little":
        result.byteswap()
    return result


def wav(path, values):
    assert not path.exists()
    if sys.byteorder != "little":
        values = array.array("h", values)
        values.byteswap()
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(RATE)
        file.writeframes(values.tobytes())


def levels(values):
    peak = max(map(abs, values), default=0)
    threshold = 104  # approximately -50 dBFS, used only for evidence, never trimming
    active = [i for i, sample in enumerate(values) if abs(sample) > threshold]
    return dict(samples=len(values), durationSeconds=len(values) / RATE,
                peakDbFS=20 * math.log10(max(peak, 1) / 32768),
                clippedSamples=sum(abs(x) >= 32767 for x in values),
                leadingBelowMinus50DbSeconds=(active[0] / RATE if active else None),
                trailingBelowMinus50DbSeconds=((len(values) - 1 - active[-1]) / RATE
                                               if active else None))


def synthesize(origin, text, speaker, directory, name):
    query = json.loads(request(origin, "/audio_query", dict(text=text, speaker=speaker),
                               method="POST"))
    if text.startswith("うごく紙工房。"):
        # Open JTalk reads 紙工房 as シコウボオ by default. Supply the name's
        # phonemes explicitly through the official accent-phrase API; leave
        # the rest of the sentence and the engine's standard voice unchanged.
        assert query["kana"].split("、")[0] == "ウゴ'_ク/シコウ'ボオ"
        reading = "ウゴ'_ク/カミコ'オボオ"
        phrases = json.loads(request(origin, "/accent_phrases",
            dict(text=reading, speaker=speaker, is_kana="true"), method="POST"))
        assert len(phrases) == 2
        phrases[-1]["pause_mora"] = query["accent_phrases"][1]["pause_mora"]
        query["accent_phrases"] = phrases + query["accent_phrases"][2:]
        query["kana"] = reading + "、" + query["kana"].split("、", 1)[1]
    query.update(SETTINGS)
    save(directory / f"{name}.query.json", query)
    audio = request(origin, "/synthesis", dict(speaker=speaker,
                    enable_interrogative_upspeak="false"), query, "POST")
    raw = directory / f"{name}.raw.wav"
    with raw.open("xb") as file:
        file.write(audio)
    with wave.open(io.BytesIO(audio), "rb") as file:
        assert file.getnchannels() == 1 and file.getframerate() == RATE
    # Two-pass loudness normalization; no time stretching or speech trimming.
    measurement = ffmpeg("-i", raw, "-af", "loudnorm=I=-18:TP=-2:LRA=7:print_format=json",
                         "-f", "null", "-")
    measured, _ = json.JSONDecoder().raw_decode(measurement[measurement.rfind("{"):])
    assert all(math.isfinite(float(measured[k])) for k in
               ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset"))
    args = ("loudnorm=I=-18:TP=-2:LRA=7:linear=true:"
            f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
            f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
            f"offset={measured['target_offset']}")
    normalized = directory / f"{name}.wav"
    ffmpeg("-v", "error", "-i", raw, "-af", args, "-ar", RATE,
           "-ac", 1, "-c:a", "pcm_s16le", normalized)
    samples = pcm(normalized)
    stats = levels(samples)
    assert stats["clippedSamples"] == 0 and stats["peakDbFS"] < -1.8
    assert stats["leadingBelowMinus50DbSeconds"] >= 0.12
    assert stats["trailingBelowMinus50DbSeconds"] >= 0.15
    result = dict(file=str(normalized), sha256=digest(normalized), kana=query["kana"],
                  **stats, loudnessInput=measured)
    save(directory / f"{name}.measurement.json", result)
    return result, samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("preview", "render"))
    parser.add_argument("--engine", default="http://127.0.0.1:50121")
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--plan", type=Path, default=Path(__file__).with_name("narration-plan.json"))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--edl", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--speaker", type=int, choices=(10005, 10001))
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.engine)
    assert origin.scheme == "http" and origin.hostname == "127.0.0.1"
    assert origin.path == "" and not origin.query and not origin.fragment and not origin.username
    version = json.loads(request(args.engine, "/version"))
    assert version == "0.24.0", version
    speakers = json.loads(request(args.engine, "/speakers"))
    style_names = {style["id"]: person["name"] for person in speakers for style in person["styles"]}
    assert style_names[10005] == "女声1" and style_names[10001] == "男声1"
    args.work.mkdir(parents=True, exist_ok=False)
    save(args.work / "engine.json", dict(version=version, speakers=speakers, settings=SETTINGS))
    if args.mode == "preview":
        samples = []
        for speaker in (10005, 10001):
            result, _ = synthesize(args.engine, SAMPLE, speaker, args.work, f"sample-{speaker}")
            samples.append(dict(speaker=speaker, voice=style_names[speaker], text=SAMPLE, **result))
        save(args.work / "samples.json", samples)
        print(json.dumps(samples, ensure_ascii=False), flush=True)
        return
    assert args.source and args.out and args.edl and args.speaker is not None
    assert digest(args.source) == SOURCE_SHA256, "Use only the adopted Goal014 final movie"
    plan = json.loads(args.plan.read_text())
    edl = json.loads(args.edl.read_text())
    assert edl["sha256"] == plan["sourceSha256"] == SOURCE_SHA256
    assert edl["durationSeconds"] == plan["durationSeconds"] == 160.6
    assert edl["frames"] == 4015
    args.out.mkdir(parents=True, exist_ok=False)
    duration = plan["durationSeconds"]
    track = array.array("h", [0]) * round(duration * RATE)
    segments = []
    previous_end = 0
    for entry in plan["segments"]:
        start = entry["startSeconds"]
        assert start >= previous_end and entry["untilSeconds"] <= duration
        scene_ids = entry["sceneIds"]
        scenes = [s for s in edl["scenes"] if s["id"] in scene_ids]
        assert len(scenes) == len(scene_ids)
        assert start >= min(s["outputStart"] for s in scenes)
        assert entry["untilSeconds"] <= max(s["outputEnd"] for s in scenes)
        result, samples = synthesize(args.engine, entry["spokenText"], args.speaker,
                                     args.work, entry["id"])
        end = start + len(samples) / RATE
        assert end <= entry["untilSeconds"], (entry["id"], end, entry["untilSeconds"],
                                                  "Shorten script; never speed up or trim speech")
        offset = round(start * RATE)
        track[offset:offset + len(samples)] = samples
        segments.append({**entry, **result, "endSeconds": end})
        previous_end = end
        print(json.dumps(dict(id=entry["id"], start=start, end=end, kana=result["kana"]),
                         ensure_ascii=False), flush=True)
    narration = args.out / "narration.wav"
    wav(narration, track)
    movie = args.out / "demo-narrated.mp4"
    credit = f"音声：VOICEVOX Nemo（{style_names[args.speaker]}）"
    ffmpeg("-v", "error", "-i", args.source, "-i", narration,
           "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
           "-b:a", "160k", "-ar", RATE, "-map_metadata", "0", "-metadata",
           "comment=" + credit, "-metadata:s:a:0", "language=jpn",
           "-movflags", "+faststart", "-t", duration, movie)
    assert digest(args.source) == SOURCE_SHA256
    manifest = dict(format="ugoku-local-nemo-narration-v1", source=str(args.source.resolve()),
                    sourceSha256=SOURCE_SHA256, edlSha256=digest(args.edl),
                    planSha256=digest(args.plan), movieSha256=digest(movie),
                    narrationSha256=digest(narration), durationSeconds=duration,
                    engineVersion=version, voice=style_names[args.speaker],
                    speaker=args.speaker, settings=SETTINGS, segments=segments,
                    videoCodec="copy", audioCodec="aac", credit=credit,
                    narrationLevels=levels(track), cloudCalls=0, externalSpeechApiCalls=0,
                    humanListening="not claimed; see separate final review")
    save(args.out / "manifest.json", manifest)
    lines = ["うごく紙工房 — ナレーション時刻付き原稿", "", credit, ""]
    for s in segments:
        def stamp(t):
            return f"{int(t // 60):02}:{t % 60:06.3f}"
        lines.extend([f"{stamp(s['startSeconds'])}–{stamp(s['endSeconds'])} [{s['id']}]",
                      s["text"], "読み：" + s["spokenText"], ""])
    (args.out / "narration-timed.txt").write_text("\n".join(lines), encoding="utf-8")
    (args.out / "youtube-audio-credit.txt").write_text(
        credit + "\nhttps://voicevox.hiroshiba.jp/nemo/\n", encoding="utf-8")
    print(json.dumps(dict(movie=str(movie), narration=str(narration), credit=credit),
                     ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
